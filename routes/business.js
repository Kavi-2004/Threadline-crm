const db = require('../db');

async function getMe(businessId) {
  const b = await db.get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  if (!b) return { status: 404, json: { error: 'Business not found' } };
  return {
    status: 200,
    json: {
      id: b.id,
      name: b.name,
      replyTemplate: b.reply_template,
      followupDays: b.followup_days,
      staffList: JSON.parse(b.staff_list || '[]'),
    },
  };
}

async function updateMe(businessId, body) {
  const { replyTemplate, followupDays, staffList } = body;
  const b = await db.get('SELECT * FROM businesses WHERE id = ?', [businessId]);
  if (!b) return { status: 404, json: { error: 'Business not found' } };

  if (replyTemplate !== undefined) {
    await db.run('UPDATE businesses SET reply_template = ? WHERE id = ?', [replyTemplate, businessId]);
  }
  if (followupDays !== undefined) {
    const days = parseInt(followupDays, 10);
    if (!Number.isInteger(days) || days < 1) {
      return { status: 400, json: { error: 'followupDays must be a whole number of at least 1' } };
    }
    await db.run('UPDATE businesses SET followup_days = ? WHERE id = ?', [days, businessId]);
  }
  if (staffList !== undefined) {
    if (!Array.isArray(staffList)) return { status: 400, json: { error: 'staffList must be an array of names' } };
    await db.run('UPDATE businesses SET staff_list = ? WHERE id = ?', [JSON.stringify(staffList), businessId]);
  }
  return getMe(businessId);
}

module.exports = { getMe, updateMe };
