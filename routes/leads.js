const crypto = require('node:crypto');
const db = require('../db');

const MAX_FOLLOWUPS = 6;

async function listLeads(businessId) {
  const leads = await db.all('SELECT * FROM leads WHERE business_id = ? ORDER BY captured_at DESC', [businessId]);
  return { status: 200, json: leads };
}

async function getLead(businessId, leadId) {
  const lead = await db.get('SELECT * FROM leads WHERE id = ? AND business_id = ?', [leadId, businessId]);
  if (!lead) return { status: 404, json: { error: 'Lead not found' } };
  const history = await db.all('SELECT * FROM history WHERE lead_id = ? ORDER BY created_at DESC', [leadId]);
  return { status: 200, json: { ...lead, history } };
}

// --- Duplicate prevention ---
function normalizePhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

async function findDuplicate(businessId, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const candidates = await db.all('SELECT * FROM leads WHERE business_id = ? AND phone IS NOT NULL', [businessId]);
  return candidates.find(l => normalizePhone(l.phone) === norm) || null;
}

// --- Helper for calculating follow-up date (If days === 1, set to Today) ---
async function calculateNextFollowup(businessId, baseIsoString) {
  let days = await getFollowupDays(businessId);
  if (days < 1) days = 1;
  if (days > 6) days = 6;

  // If follow-up period is 1 day, make it today's timestamp so it appears immediately on the dashboard
  if (days === 1) {
    return baseIsoString;
  }
  return addDays(baseIsoString, days);
}

async function createLead(businessId, body) {
  const { name, phone, channel, lastMessage, assignedStaff, email, notes } = body;
  if (!name || !phone) return { status: 400, json: { error: 'name and phone are required' } };

  const existing = await findDuplicate(businessId, phone);
  if (existing) {
    const existingResult = await getLead(businessId, existing.id);
    return { status: 200, json: { ...existingResult.json, duplicate: true } };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const nextFollowup = await calculateNextFollowup(businessId, now);

  await db.run(
    `INSERT INTO leads (id, business_id, name, phone, channel, status, last_message, assigned_staff, email, notes, captured_at, next_followup_at, follow_up_count)
     VALUES (?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?, ?, 0)`,
    [id, businessId, name, phone, channel || 'manual', lastMessage || null, assignedStaff || null, email || null, notes || null, now, nextFollowup]
  );

  await addHistory(id, 'system', 'system', 'Lead saved to CRM', channel ? `Captured automatically from ${channel}` : 'Added manually');
  const created = await getLead(businessId, id);
  return { status: 201, json: created.json };
}

async function importLeads(businessId, rows) {
  if (!Array.isArray(rows)) return { status: 400, json: { error: 'rows must be an array' } };
  
  let imported = 0, skippedDuplicate = 0, skippedInvalid = 0;
  const importedNames = [];

  for (const row of rows) {
    const name = (row.name || '').toString().trim();
    const phone = (row.phone || '').toString().trim();
    if (!name || !phone) { skippedInvalid++; continue; }

    if (await findDuplicate(businessId, phone)) { skippedDuplicate++; continue; }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const nextFollowup = await calculateNextFollowup(businessId, now);

    await db.run(
      `INSERT INTO leads (id, business_id, name, phone, channel, status, last_message, email, notes, captured_at, next_followup_at, follow_up_count)
       VALUES (?, ?, ?, ?, 'import', 'New', NULL, ?, ?, ?, ?, 0)`,
      [id, businessId, name, phone, row.email || null, row.notes || null, now, nextFollowup]
    );
    await addHistory(id, 'system', 'system', 'Lead saved to CRM', 'Imported from Excel file');
    imported++;
    importedNames.push(name);
  }

  return { status: 200, json: { imported, skippedDuplicate, skippedInvalid, importedNames } };
}

async function updateLead(businessId, leadId, body) {
  const lead = await db.get('SELECT * FROM leads WHERE id = ? AND business_id = ?', [leadId, businessId]);
  if (!lead) return { status: 404, json: { error: 'Lead not found' } };

  const { status, nextFollowupAt, assignedStaff, email, notes } = body;
  if (status && status !== lead.status) {
    await db.run('UPDATE leads SET status = ? WHERE id = ?', [status, leadId]);
    await addHistory(leadId, 'status', 'system', 'Status changed', `${lead.status} → ${status}`);
  }
  if (nextFollowupAt !== undefined) {
    await db.run('UPDATE leads SET next_followup_at = ? WHERE id = ?', [nextFollowupAt, leadId]);
    if (nextFollowupAt) await addHistory(leadId, 'system', 'system', 'Follow-up reminder set', `Rescheduled to ${nextFollowupAt}`);
  }
  if (assignedStaff !== undefined && assignedStaff !== lead.assigned_staff) {
    await db.run('UPDATE leads SET assigned_staff = ? WHERE id = ?', [assignedStaff || null, leadId]);
    await addHistory(leadId, 'system', 'system', 'Assigned staff changed', `${lead.assigned_staff || 'Unassigned'} → ${assignedStaff || 'Unassigned'}`);
  }
  if (email !== undefined) await db.run('UPDATE leads SET email = ? WHERE id = ?', [email || null, leadId]);
  if (notes !== undefined) await db.run('UPDATE leads SET notes = ? WHERE id = ?', [notes || null, leadId]);
  return getLead(businessId, leadId);
}

async function markContacted(businessId, leadId) {
  const lead = await db.get('SELECT * FROM leads WHERE id = ? AND business_id = ?', [leadId, businessId]);
  if (!lead) return { status: 404, json: { error: 'Lead not found' } };

  const newCount = Math.min((lead.follow_up_count || 0) + 1, MAX_FOLLOWUPS);
  const now = new Date().toISOString();

  if (newCount >= MAX_FOLLOWUPS) {
    await db.run('UPDATE leads SET follow_up_count = ?, last_contacted_at = ?, next_followup_at = NULL WHERE id = ?', [newCount, now, leadId]);
    await addHistory(leadId, 'system', 'system', 'Contacted — follow-up limit reached',
      `This was follow-up ${newCount} of ${MAX_FOLLOWUPS}. No further automatic reminders will be scheduled.`);
  } else {
    let days = await getFollowupDays(businessId);
    if (days < 1) days = 1;
    if (days > 6) days = 6;
    const next = days === 1 ? now : addDays(now, days);
    await db.run('UPDATE leads SET follow_up_count = ?, last_contacted_at = ?, next_followup_at = ? WHERE id = ?', [newCount, now, next, leadId]);
    await addHistory(leadId, 'system', 'system', 'Marked as contacted',
      `Follow-up ${newCount} of ${MAX_FOLLOWUPS} completed. Next reminder in ${days} day${days === 1 ? '' : 's'}.`);
  }
  return getLead(businessId, leadId);
}

async function bumpFollowup(businessId, leadId) {
  let days = await getFollowupDays(businessId);
  if (days < 1) days = 1;
  if (days > 6) days = 6;
  const now = new Date().toISOString();
  const next = days === 1 ? now : addDays(now, days);
  await db.run('UPDATE leads SET next_followup_at = ? WHERE id = ?', [next, leadId]);
  return next;
}

async function getDashboard(businessId) {
  const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const newTodayRow = await db.get(
    `SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND captured_at LIKE ?`,
    [businessId, `${todayPrefix}%`]
  );

  const dueLeads = await db.all(
    `SELECT * FROM leads WHERE business_id = ? AND status NOT IN ('Won','Lost')
     AND next_followup_at IS NOT NULL AND next_followup_at <= ? ORDER BY next_followup_at ASC`,
    [businessId, new Date().toISOString()]
  );

  const sameDayFollowups = dueLeads.filter(l => l.next_followup_at && l.next_followup_at.slice(0, 10) === todayPrefix);

  const activeConvoRow = await db.get(
    `SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND status NOT IN ('Won','Lost')
     AND channel IN ('whatsapp','facebook','instagram')`,
    [businessId]
  );

  const contactedLeads = await db.all(
    `SELECT captured_at, last_contacted_at FROM leads WHERE business_id = ? AND last_contacted_at IS NOT NULL`,
    [businessId]
  );
  let avgResponseMinutes = null;
  if (contactedLeads.length > 0) {
    const totalMinutes = contactedLeads.reduce((sum, l) =>
      sum + (new Date(l.last_contacted_at).getTime() - new Date(l.captured_at).getTime()) / 60000, 0);
    avgResponseMinutes = Math.round(totalMinutes / contactedLeads.length);
  }

  return {
    status: 200,
    json: {
      newLeadsToday: Number(newTodayRow.n),
      followupDays: await getFollowupDays(businessId),
      dueForFollowupCount: dueLeads.length,
      dueForFollowup: dueLeads,
      sameDayFollowups: sameDayFollowups,
      maxFollowups: MAX_FOLLOWUPS,
      activeConversations: Number(activeConvoRow.n),
      avgResponseMinutes,
    },
  };
}

async function getFollowupDays(businessId) {
  const b = await db.get('SELECT followup_days FROM businesses WHERE id = ?', [businessId]);
  return (b && b.followup_days) || 3;
}

async function addHistoryEntry(businessId, leadId, body) {
  const lead = await db.get('SELECT * FROM leads WHERE id = ? AND business_id = ?', [leadId, businessId]);
  if (!lead) return { status: 404, json: { error: 'Lead not found' } };
  const { type, channel, label, detail } = body;
  if (!type || !label) return { status: 400, json: { error: 'type and label are required' } };
  await addHistory(leadId, type, channel || null, label, detail || '');
  return getLead(businessId, leadId);
}

async function listFollowups(businessId) {
  const leads = await db.all('SELECT * FROM leads WHERE business_id = ? ORDER BY next_followup_at ASC', [businessId]);
  const now = Date.now();
  const grouped = { overdue: [], today: [], upcoming: [] };
  for (const l of leads) {
    if (!l.next_followup_at) continue;
    const due = new Date(l.next_followup_at).getTime();
    const isToday = new Date(l.next_followup_at).toDateString() === new Date().toDateString();

    if (isToday) {
      grouped.today.push(l);
    } else if (due < now) {
      grouped.overdue.push(l);
    } else {
      grouped.upcoming.push(l);
    }
  }
  return { status: 200, json: grouped };
}

async function addHistory(leadId, type, channel, label, detail) {
  await db.run(
    'INSERT INTO history (id, lead_id, type, channel, label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), leadId, type, channel, label, detail, new Date().toISOString()]
  );
}
function addDays(isoString, days) {
  return new Date(new Date(isoString).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  listLeads, getLead, createLead, importLeads, updateLead, addHistoryEntry, listFollowups, addHistory,
  bumpFollowup, markContacted, getDashboard, getFollowupDays, findDuplicate, normalizePhone, MAX_FOLLOWUPS,
};