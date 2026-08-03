// whatsapp/qr-session.js
//
// This connects to WhatsApp the same way WhatsApp Web/Desktop does: by
// scanning a QR code to link as an additional device on someone's real
// WhatsApp account. It does NOT use Meta's official WhatsApp Business
// Platform — it uses Baileys, an open-source library that reverse-engineers
// the WhatsApp Web protocol.
//
// IMPORTANT — read before running this in production:
// - This is against WhatsApp's Terms of Service for automated/business use.
//   The connected phone number can be permanently banned by WhatsApp at any
//   time, with no appeal process.
// - It requires packages NOT included by default in this project (kept
//   dependency-free otherwise). Install them yourself when you're ready:
//     npm install @whiskeysockets/baileys qrcode pino
// - The session credentials saved to disk (whatsapp-sessions/<businessId>/)
//   are equivalent to being logged into that WhatsApp account — protect
//   that folder like a password, and never commit it to git.
// - This needs a long-running Node process (not serverless) since the
//   socket connection must stay open continuously.

const path = require('node:path');
const fs = require('node:fs');

const SESSIONS_DIR = path.join(__dirname, '..', 'whatsapp-sessions');
const sessions = new Map(); // businessId -> { sock, status, qrDataUrl }

function loadDeps() {
  // Lazy-required so the rest of the app works with zero installed
  // dependencies for anyone who isn't using this feature.
  const baileys = require('@whiskeysockets/baileys');
  const QRCode = require('qrcode');
  const pino = require('pino');
  return { makeWASocket: baileys.default, useMultiFileAuthState: baileys.useMultiFileAuthState, DisconnectReason: baileys.DisconnectReason, QRCode, pino };
}

async function startSession(businessId) {
  const existing = sessions.get(businessId);
  if (existing && existing.status !== 'disconnected') return existing;

  const { makeWASocket, useMultiFileAuthState, DisconnectReason, QRCode, pino } = loadDeps();

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const authFolder = path.join(SESSIONS_DIR, businessId);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
  const sessionInfo = { sock, status: 'connecting', qrDataUrl: null };
  sessions.set(businessId, sessionInfo);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      sessionInfo.qrDataUrl = await QRCode.toDataURL(qr);
      sessionInfo.status = 'waiting_scan';
    }
    if (connection === 'open') {
      sessionInfo.status = 'connected';
      sessionInfo.qrDataUrl = null;
    }
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      sessionInfo.status = 'disconnected';
      if (!loggedOut) startSession(businessId); // transient drop — reconnect automatically
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue; // skip group chats — leads are 1:1 only
      const phone = jid.split('@')[0];
      const senderName = msg.pushName || 'WhatsApp contact';
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      await handleIncomingMessage(businessId, sock, jid, phone, senderName, text);
    }
  });

  return sessionInfo;
}

async function handleIncomingMessage(businessId, sock, jid, phone, senderName, text) {
  // Reuses the exact same CRM logic as the official Cloud API webhook:
  // duplicate-safe lead lookup/creation, follow-up scheduling, and history.
  const { getOrCreateLead, sendAutoReply } = require('../routes/webhooks');
  const lead = getOrCreateLead(businessId, 'whatsapp', phone, senderName, phone, text);
  await sendAutoReply(businessId, lead, 'whatsapp', (message) => sock.sendMessage(jid, { text: message }));
}

function getStatus(businessId) {
  const s = sessions.get(businessId);
  if (!s) return { status: 'not_connected', qrDataUrl: null };
  return { status: s.status, qrDataUrl: s.qrDataUrl };
}

async function disconnectSession(businessId) {
  const s = sessions.get(businessId);
  if (!s) return;
  try { await s.sock.logout(); } catch { /* already disconnected */ }
  sessions.delete(businessId);
  // Also wipe the saved session so a future "Connect" starts a fresh QR pairing.
  const authFolder = path.join(SESSIONS_DIR, businessId);
  fs.rmSync(authFolder, { recursive: true, force: true });
}

module.exports = { startSession, getStatus, disconnectSession };
