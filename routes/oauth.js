// routes/oauth.js
//
// This is the correct way to connect Facebook/Instagram: the user is
// redirected to Facebook's own login page (facebook.com), logs in there,
// and grants permissions. This server only ever receives a token — never
// a password. Uses Node's built-in fetch (Node 18+), no extra dependency.
//
// Needs real credentials from a Meta for Developers app to actually run:
//   META_APP_ID, META_APP_SECRET, PUBLIC_BASE_URL (e.g. https://yourapp.up.railway.app)
// Untested against Meta's live servers in this sandbox (no internet access
// here) — the flow below follows Meta's documented OAuth spec, but you'll
// want to test it for real once deployed with real credentials.

const db = require('../db');
const crypto = require('node:crypto');
const { signToken, verifyToken } = require('../lib/auth');

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
const SCOPES = 'pages_show_list,pages_messaging,leads_retrieval,instagram_basic,instagram_manage_messages,pages_manage_metadata';

function notConfigured() {
  return {
    status: 200,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:60px auto;line-height:1.6;">
      <h2>Facebook login isn't set up on this server yet</h2>
      <p>This needs a real Meta for Developers app. Set these environment variables on your server, then restart it:</p>
      <pre style="background:#f4f4f4;padding:12px;border-radius:6px;">META_APP_ID=&lt;your app id&gt;
META_APP_SECRET=&lt;your app secret&gt;
PUBLIC_BASE_URL=&lt;your server's public URL&gt;</pre>
      <p>See the README section "Facebook &amp; Instagram — real OAuth login" for the full walkthrough, including registering the callback URL with Meta.</p>
      <p>Close this tab and go back to the CRM.</p>
    </div>`,
  };
}

// The frontend navigates the browser here directly (can't send an
// Authorization header on a plain link), so the login token is passed as a
// query param instead, then re-packed into a short-lived signed `state`
// value for the round trip through Facebook.
function startFacebookLogin(query) {
  if (!APP_ID || !APP_SECRET) return notConfigured();
  const payload = verifyToken(query.token || '');
  if (!payload) {
    return { status: 200, html: '<p>Your session expired. Close this tab, log back into the CRM, and try connecting again.</p>' };
  }

  const state = signToken({ businessId: payload.businessId, purpose: 'oauth-fb' }, 600); // 10 min to complete login
  const redirectUri = `${BASE_URL}/api/oauth/facebook/callback`;
  const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${SCOPES}`;
  return { status: 302, redirect: url };
}

async function handleFacebookCallback(query) {
  if (!APP_ID || !APP_SECRET) return notConfigured();
  const statePayload = verifyToken(query.state || '');
  if (!statePayload || statePayload.purpose !== 'oauth-fb') {
    return { status: 400, html: '<p>This login link expired or is invalid. Close this tab and try connecting again.</p>' };
  }
  if (query.error) {
    return { status: 200, html: `<p>Facebook login was cancelled (${query.error}). Close this tab and try again.</p>` };
  }

  const redirectUri = `${BASE_URL}/api/oauth/facebook/callback`;
  try {
    // Step 1: exchange the temporary code for a user access token.
    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${query.code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error?.message || 'No access token returned');

    // Step 2: list the Facebook Pages this user manages (each Page has its
    // own access token, which is what we actually use to send/receive
    // messages and read lead forms).
    const pagesRes = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${tokenData.access_token}`
    );
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];

    for (const page of pages) {
      await db.run(
        `INSERT INTO channel_accounts (id, business_id, channel, account_id) VALUES (?, ?, 'facebook', ?)
         ON CONFLICT(channel, account_id) DO UPDATE SET business_id = excluded.business_id`,
        [crypto.randomUUID(), statePayload.businessId, page.id]
      );
      // Store the page access token too — needed later to actually send
      // messages / read lead forms through this specific Page.
      await db.run(
        `INSERT INTO channel_tokens (channel_account_key, access_token) VALUES (?, ?)
         ON CONFLICT(channel_account_key) DO UPDATE SET access_token = excluded.access_token`,
        [`facebook:${page.id}`, page.access_token]
      );

      // A Facebook Page can have a linked Instagram professional account —
      // this is the ONLY legitimate way to connect Instagram; there's no
      // separate Instagram login step.
      if (page.instagram_business_account?.id) {
        const igId = page.instagram_business_account.id;
        await db.run(
          `INSERT INTO channel_accounts (id, business_id, channel, account_id) VALUES (?, ?, 'instagram', ?)
           ON CONFLICT(channel, account_id) DO UPDATE SET business_id = excluded.business_id`,
          [crypto.randomUUID(), statePayload.businessId, igId]
        );
        await db.run(
          `INSERT INTO channel_tokens (channel_account_key, access_token) VALUES (?, ?)
           ON CONFLICT(channel_account_key) DO UPDATE SET access_token = excluded.access_token`,
          [`instagram:${igId}`, page.access_token]
        );
      }
    }

    const igCount = pages.filter(p => p.instagram_business_account?.id).length;
    return {
      status: 200,
      html: `<p>Connected ${pages.length} Facebook Page(s)${igCount ? ` and ${igCount} linked Instagram account(s)` : ''}. You can close this tab and go back to the dashboard.</p>`,
    };
  } catch (err) {
    return { status: 500, html: `<p>Something went wrong connecting Facebook: ${err.message}</p>` };
  }
}

module.exports = { startFacebookLogin, handleFacebookCallback };
