// server.js — Threadline CRM Entry Point
require('dotenv').config();
const whatsappQr = require('./lib/whatsapp-qr');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const db = require('./db');
const { verifyToken } = require('./lib/auth');
const auth = require('./routes/auth');
const leads = require('./routes/leads');
const webhooks = require('./routes/webhooks');
const business = require('./routes/business');
const oauth = require('./routes/oauth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(html);
}
function sendRedirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function getAuthedBusinessId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const business = await db.get('SELECT id FROM businesses WHERE id = ?', [payload.businessId]);
  return business ? payload.businessId : null;
}

function serveStatic(req, res, urlPath) {
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    return res.end();
  }

  try {
    // ---- Auth Routes ----
    if (p === '/api/auth/signup' && req.method === 'POST') {
      const r = await auth.signup(await readBody(req));
      return send(res, r.status, r.json);
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const r = await auth.login(await readBody(req));
      return send(res, r.status, r.json);
    }

    // ---- WhatsApp QR Routes ----
    if (p === '/api/whatsapp-qr/status' && req.method === 'GET') {
      return send(res, 200, whatsappQr.getStatus());
    }
    if (p === '/api/whatsapp-qr/start' && req.method === 'POST') {
      await whatsappQr.startWhatsAppQR();
      return send(res, 200, { status: 'started' });
    }
    if (p === '/api/whatsapp-qr/disconnect' && req.method === 'POST') {
      const r = await whatsappQr.disconnectWhatsApp();
      return send(res, 200, r);
    }

    // ---- Meta Webhooks (WhatsApp, Facebook, Instagram) ----
    if (p === '/api/webhooks/whatsapp' && req.method === 'GET') {
      const r = webhooks.verifyWhatsApp(Object.fromEntries(url.searchParams));
      if (r.raw) { res.writeHead(r.status); return res.end(r.raw); }
      return send(res, r.status, r.json);
    }
    if (p === '/api/webhooks/whatsapp' && req.method === 'POST') {
      const r = await webhooks.handleWhatsApp(await readBody(req));
      return send(res, r.status, r.json);
    }

    // --- Facebook Webhook GET Verification (Aluthin Ekatukala) ---
    if (p === '/api/webhooks/facebook' && req.method === 'GET') {
      const r = webhooks.verifyFacebook(Object.fromEntries(url.searchParams));
      if (r.raw) { res.writeHead(r.status); return res.end(r.raw); }
      return send(res, r.status, r.json);
    }

    if (p === '/api/webhooks/facebook' && req.method === 'POST') {
      const r = await webhooks.handleFacebookLead(await readBody(req));
      return send(res, r.status, r.json);
    }
    if (p === '/api/webhooks/instagram' && req.method === 'POST') {
      const r = await webhooks.handleInstagram(await readBody(req));
      return send(res, r.status, r.json);
    }

    // ---- OAuth (Facebook / Instagram Login) ----
    if (p === '/api/oauth/facebook/start' && req.method === 'GET') {
      const r = oauth.startFacebookLogin(Object.fromEntries(url.searchParams));
      if (r.redirect) return sendRedirect(res, r.redirect);
      if (r.html) return sendHtml(res, r.status, r.html);
      return send(res, r.status, r.json);
    }
    if (p === '/api/oauth/facebook/callback' && req.method === 'GET') {
      const r = await oauth.handleFacebookCallback(Object.fromEntries(url.searchParams));
      return sendHtml(res, r.status, r.html);
    }

    // ---- Protected API Endpoints (Requires Login) ----
    if (p.startsWith('/api/')) {
      const businessId = await getAuthedBusinessId(req);
      if (!businessId) return send(res, 401, { error: 'Missing or invalid auth token' });

      if (p === '/api/leads' && req.method === 'GET') {
        const r = await leads.listLeads(businessId);
        return send(res, r.status, r.json);
      }
      if (p === '/api/leads' && req.method === 'POST') {
        const r = await leads.createLead(businessId, await readBody(req));
        return send(res, r.status, r.json);
      }
      if (p === '/api/leads/import' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await leads.importLeads(businessId, body.rows);
        return send(res, r.status, r.json);
      }
      if (p === '/api/followups' && req.method === 'GET') {
        const r = await leads.listFollowups(businessId);
        return send(res, r.status, r.json);
      }
      if (p === '/api/dashboard' && req.method === 'GET') {
        const r = await leads.getDashboard(businessId);
        return send(res, r.status, r.json);
      }
      if (p === '/api/me' && req.method === 'GET') {
        const r = await business.getMe(businessId);
        return send(res, r.status, r.json);
      }
      if (p === '/api/me' && req.method === 'PATCH') {
        const r = await business.updateMe(businessId, await readBody(req));
        return send(res, r.status, r.json);
      }
      if (p === '/api/channel-accounts' && req.method === 'POST') {
        const r = await webhooks.connectChannelAccount(businessId, await readBody(req));
        return send(res, r.status, r.json);
      }

      const leadMatch = p.match(/^\/api\/leads\/([^/]+)$/);
      if (leadMatch && req.method === 'GET') {
        const r = await leads.getLead(businessId, leadMatch[1]);
        return send(res, r.status, r.json);
      }
      if (leadMatch && req.method === 'PATCH') {
        const r = await leads.updateLead(businessId, leadMatch[1], await readBody(req));
        return send(res, r.status, r.json);
      }

      const historyMatch = p.match(/^\/api\/leads\/([^/]+)\/history$/);
      if (historyMatch && req.method === 'POST') {
        const r = await leads.addHistoryEntry(businessId, historyMatch[1], await readBody(req));
        return send(res, r.status, r.json);
      }

      const contactedMatch = p.match(/^\/api\/leads\/([^/]+)\/contacted$/);
      if (contactedMatch && req.method === 'POST') {
        const r = await leads.markContacted(businessId, contactedMatch[1]);
        return send(res, r.status, r.json);
      }

      return send(res, 404, { error: 'Not found' });
    }

    return serveStatic(req, res, p);
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

db.initSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Threadline CRM server running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });