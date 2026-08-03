// routes/webhooks.js
//
// These are the endpoints Meta calls when a customer messages you on
// WhatsApp, comments/DMs on Instagram, or fills a Facebook Lead Ad form.
// sendAutoReply() logs what would be sent by default; pass a realSendFn to
// actually deliver it (used by the live QR-connected WhatsApp session).

const crypto = require('node:crypto');
const db = require('../db');
const { addHistory, getFollowupDays, bumpFollowup } = require('./leads');

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'change-this-verify-token';

async function findBusinessId(channel, accountId) {
  const row = await db.get('SELECT business_id FROM channel_accounts WHERE channel = ? AND account_id = ?', [channel, accountId]);
  return row ? row.business_id : null;
}

async function getOrCreateLead(businessId, channel, senderId, senderName, phone, messageText) {
  let lead = await db.get('SELECT * FROM leads WHERE business_id = ? AND phone = ? AND channel = ?', [businessId, phone || senderId, channel]);

  const now = new Date().toISOString();
  if (!lead) {
    const id = crypto.randomUUID();
    const days = await getFollowupDays(businessId);
    const nextFollowup = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      `INSERT INTO leads (id, business_id, name, phone, channel, status, last_message, captured_at, next_followup_at)
       VALUES (?, ?, ?, ?, ?, 'New', ?, ?, ?)`,
      [id, businessId, senderName || 'Unknown contact', phone || senderId, channel, messageText, now, nextFollowup]
    );
    lead = await db.get('SELECT * FROM leads WHERE id = ?', [id]);
    await addHistory(id, 'system', 'system', 'Lead saved to CRM', `Captured automatically from ${channel}`);
  } else {
    await db.run('UPDATE leads SET last_message = ? WHERE id = ?', [messageText, lead.id]);
    // Per spec: any inbound message re-creates the follow-up reminder, even
    // for a customer who already exists — so the dashboard always reflects
    // "last message was N days ago", not just "first ever contact".
    await bumpFollowup(businessId, lead.id);
    lead = await db.get('SELECT * FROM leads WHERE id = ?', [lead.id]);
  }
  await addHistory(lead.id, 'message', channel, 'Inbound message', `"${messageText}"`);
  return lead;
}

async function sendAutoReply(businessId, lead, channel, realSendFn) {
  const business = await db.get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const firstName = (lead.name || '').split(' ')[0] || 'there';
  const message = (business.reply_template || 'Thanks for reaching out!').replace('{{first_name}}', firstName);

  if (realSendFn) {
    // A live, connected channel (e.g. the QR-linked WhatsApp session) can
    // actually deliver the message, not just log it.
    try {
      await realSendFn(message);
      await addHistory(lead.id, 'autoreply', channel, 'Auto-reply sent', message);
    } catch (err) {
      await addHistory(lead.id, 'system', channel, 'Auto-reply failed to send', err.message);
    }
    return;
  }

  // --- Real send would go here, e.g. for the official WhatsApp Cloud API: ---
  // await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ messaging_product: 'whatsapp', to: lead.phone, text: { body: message } })
  // });

  await addHistory(lead.id, 'autoreply', channel, 'Auto-reply sent', message);
}

// --- WhatsApp ---
function verifyWhatsApp(query) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === VERIFY_TOKEN) {
    return { status: 200, raw: query['hub.challenge'] };
  }
  return { status: 403, json: { error: 'Verification failed' } };
}

async function handleWhatsApp(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const phoneNumberId = change?.metadata?.phone_number_id;
    const message = change?.messages?.[0];
    if (!message) return { status: 200, json: { ignored: true } }; // status update, not a message

    const businessId = await findBusinessId('whatsapp', phoneNumberId);
    if (!businessId) return { status: 200, json: { ignored: true, reason: 'Unmapped WhatsApp account' } };

    const senderName = change.contacts?.[0]?.profile?.name;
    const lead = await getOrCreateLead(businessId, 'whatsapp', message.from, senderName, message.from, message.text?.body || '');
    await sendAutoReply(businessId, lead, 'whatsapp');
    return { status: 200, json: { ok: true, leadId: lead.id } };
  } catch (err) {
    return { status: 500, json: { error: err.message } };
  }
}

// --- Facebook Lead Ads ---
async function handleFacebookLead(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const pageId = entry?.id;
    const businessId = await findBusinessId('facebook', pageId);
    if (!businessId) return { status: 200, json: { ignored: true, reason: 'Unmapped Facebook page' } };

    // In production you'd call the Graph API with change.leadgen_id to fetch
    // the actual form field answers (name, phone, etc).
    const lead = await getOrCreateLead(businessId, 'facebook', change.leadgen_id, 'New Facebook lead', null, 'Submitted a lead form');
    await sendAutoReply(businessId, lead, 'facebook');
    return { status: 200, json: { ok: true, leadId: lead.id } };
  } catch (err) {
    return { status: 500, json: { error: err.message } };
  }
}

// --- Instagram ---
async function handleInstagram(body) {
  try {
    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    const igAccountId = entry?.id;
    const businessId = await findBusinessId('instagram', igAccountId);
    if (!businessId) return { status: 200, json: { ignored: true, reason: 'Unmapped Instagram account' } };

    const senderId = messaging?.sender?.id;
    const text = messaging?.message?.text || '';
    const lead = await getOrCreateLead(businessId, 'instagram', senderId, 'Instagram contact', senderId, text);
    await sendAutoReply(businessId, lead, 'instagram');
    return { status: 200, json: { ok: true, leadId: lead.id } };
  } catch (err) {
    return { status: 500, json: { error: err.message } };
  }
}

async function connectChannelAccount(businessId, body) {
  const { channel, accountId } = body;
  if (!channel || !accountId) return { status: 400, json: { error: 'channel and accountId are required' } };
  await db.run(
    `INSERT INTO channel_accounts (id, business_id, channel, account_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel, account_id) DO UPDATE SET business_id = excluded.business_id`,
    [crypto.randomUUID(), businessId, channel, accountId]
  );
  return { status: 200, json: { connected: true, channel, accountId } };
}

module.exports = {
  verifyWhatsApp, handleWhatsApp, handleFacebookLead, handleInstagram, connectChannelAccount,
  getOrCreateLead, sendAutoReply, findBusinessId,
};
