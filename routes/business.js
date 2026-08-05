const db = require('../db');

async function getMe(businessId) {
  const b = await db.get('SELECT id, name, reply_template, followup_days, staff_list, created_at FROM businesses WHERE id = ?', [businessId]);
  if (!b) return { status: 404, json: { error: 'Business not found' } };
  return {
    status: 200,
    json: {
      ...b,
      staff_list: JSON.parse(b.staff_list || '[]'),
    },
  };
}

async function updateMe(businessId, body) {
  const { name, replyTemplate, followupDays, staffList } = body;
  
  // Strict Validation: Follow-up period must be between 1 and 6
  if (followupDays !== undefined) {
    const daysNum = Number(followupDays);
    if (isNaN(daysNum) || daysNum < 1 || daysNum > 6) {
      return { status: 400, json: { error: 'Follow-up period එක දින 1 සහ 6 අතර අගයක් විය යුතුය!' } };
    }
  }

  const b = await db.get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  if (!b) return { status: 404, json: { error: 'Business not found' } };

  const newName = name !== undefined ? name : b.name;
  const newTemplate = replyTemplate !== undefined ? replyTemplate : b.reply_template;
  const newDays = followupDays !== undefined ? Number(followupDays) : b.followup_days;
  const newStaff = staffList !== undefined ? JSON.stringify(staffList) : b.staff_list;

  await db.run(
    'UPDATE businesses SET name = ?, reply_template = ?, followup_days = ?, staff_list = ? WHERE id = ?',
    [newName, newTemplate, newDays, newStaff, businessId]
  );

  return getMe(businessId);
}

module.exports = { getMe, updateMe };