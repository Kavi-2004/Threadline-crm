// lib/whatsapp-qr.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const SESSION_DIR = path.join(__dirname, '..', 'auth_info_baileys');

let sock = null;
let qrDataUrl = null;
let connectionStatus = 'not_connected'; // not_connected, waiting_scan, connecting, connected

async function startWhatsAppQR() {
  if (connectionStatus === 'connected' || connectionStatus === 'connecting') return;

  connectionStatus = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr);
      connectionStatus = 'waiting_scan';
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrDataUrl = null;
      console.log('WhatsApp connected successfully via QR!');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      qrDataUrl = null;
      if (shouldReconnect) {
        startWhatsAppQR();
      } else {
        console.log('WhatsApp connection logged out.');
        if (fs.existsSync(SESSION_DIR)) {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

function getStatus() {
  return {
    status: connectionStatus,
    qrDataUrl: qrDataUrl
  };
}

async function disconnectWhatsApp() {
  if (sock) {
    await sock.logout().catch(() => {});
  }
  connectionStatus = 'not_connected';
  qrDataUrl = null;
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
  return { status: 'not_connected' };
}

module.exports = { startWhatsAppQR, getStatus, disconnectWhatsApp };