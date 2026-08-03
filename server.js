// server.js — the entry point. Built on Node's built-in http module (no
// Express) so this runs with zero installed dependencies (SQLite mode).
// For PostgreSQL, set DATABASE_URL and run `npm install pg` — see README.

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
  // A syntactically valid token can still point at a business that no
  // longer exists (e.g. the database was reset). Treat that the same as
  // "not logged in" rather than letting individual endpoints 404 on it
  // inconsistently.
  const business = await db.get('SELECT id FROM businesses WHERE id = ?', [payload.businessId]);
  return business ? payload.businessId : null;
}

// Serve the dashboard's static files (html/css/js)
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
    // ---- Public auth routes ----
    if (p === '/api/auth/signup' && req.method === 'POST') {
      const r = await auth.signup(await readBody(req));
      return send(res, r.status, r.json);
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const r = await auth.login(await readBody(req));
      return send(res, r.status, r.json);
    }

    // ---- Meta webhooks (public — Meta calls these directly, no user token) ----
    if (p === '/api/webhooks/whatsapp' && req.method === 'GET') {
      const r = webhooks.verifyWhatsApp(Object.fromEntries(url.searchParams));
      if (r.raw) { res.writeHead(r.status); return res.end(r.raw); }
      return send(res, r.status, r.json);
    }
    if (p === '/api/webhooks/whatsapp' && req.method === 'POST') {
      const r = await webhooks.handleWhatsApp(await readBody(req));
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

    // ---- OAuth (public — the browser navigates here directly, no auth header) ----
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

    // ---- Everything below requires a logged-in business ----
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

      // --- QR-based WhatsApp connection (disabled by default — not linked
      // from the UI. See whatsapp/qr-session.js for why.) ---
      if (p === '/api/whatsapp-qr/start' && req.method === 'POST') {
        try {
          const qrSession = require('./whatsapp/qr-session');
          await qrSession.startSession(businessId);
          return send(res, 200, qrSession.getStatus(businessId));
        } catch (err) {
          if (err.code === 'MODULE_NOT_FOUND') {
            // Not an error — an expected, handled state. A 500 here would
            // wrongly suggest something broke, when really it's just "this
            // optional feature hasn't been set up yet."
            return send(res, 200, { status: 'not_installed', error: 'Missing dependency. Run: npm install @whiskeysockets/baileys qrcode pino' });
          }
          return send(res, 500, { error: err.message });
        }
      }
      if (p === '/api/whatsapp-qr/status' && req.method === 'GET') {
        try {
          const qrSession = require('./whatsapp/qr-session');
          return send(res, 200, qrSession.getStatus(businessId));
        } catch (err) {
          if (err.code === 'MODULE_NOT_FOUND') return send(res, 200, { status: 'not_installed' });
          return send(res, 500, { error: err.message });
        }
      }
      if (p === '/api/whatsapp-qr/disconnect' && req.method === 'POST') {
        try {
          const qrSession = require('./whatsapp/qr-session');
          await qrSession.disconnectSession(businessId);
          return send(res, 200, { disconnected: true });
        } catch (err) {
          return send(res, 500, { error: err.message });
        }
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

    // ---- Static dashboard files ----
    return serveStatic(req, res, p);
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

// Schema must be ready before the server accepts any requests — this runs
// once at startup, works identically whether the backend is SQLite or
// PostgreSQL.
db.initSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Threadline CRM server running at http://localhost:${PORT} (database: ${db.isPostgres ? 'PostgreSQL' : 'SQLite'})`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
