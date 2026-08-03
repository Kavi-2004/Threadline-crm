# Threadline CRM

A minimal, working multi-tenant CRM backend + dashboard for capturing leads
from WhatsApp, Facebook, and Instagram, auto-replying, and tracking
follow-ups. Built with **zero external npm packages** — just Node's built-in
`http`, `crypto`, and `node:sqlite` modules — so there's nothing to install
to run it locally.

## What's actually real here vs. what's simulated

| Feature | Status |
|---|---|
| Signup / login (multi-tenant, password hashing, tokens) | ✅ Fully real |
| Database (SQLite file, persists between restarts) | ✅ Fully real |
| Leads, history timeline, follow-up reminders | ✅ Fully real |
| Webhook endpoints for WhatsApp / Facebook / Instagram | ✅ Real endpoints, correctly shaped for Meta's payloads |
| Actually *receiving* messages from real WhatsApp/FB/IG | ⚠️ Needs your Meta Business account + a public URL (see below) |
| Actually *sending* the auto-reply out to the customer | ⚠️ Currently only logs what it would send — one `fetch()` call away from real (marked in `routes/webhooks.js`) |
| Billing / subscriptions | ❌ Not built — only needed if you plan to charge other businesses to use this |

## 1. Run it locally

Requires **Node.js 22.5 or newer** (for built-in SQLite).

```bash
node server.js
```

Open `http://localhost:3000` — you'll see a signup screen. Create an
account, and you're using a real, working CRM (just with no messages
flowing in yet).

## 2. Test it without any real Meta account

You can simulate an inbound WhatsApp message with curl, which is exactly
what Meta would send to your webhook:

```bash
curl -X POST localhost:3000/api/webhooks/whatsapp -H "Content-Type: application/json" -d '{
  "entry":[{"changes":[{"value":{
    "metadata":{"phone_number_id":"1234567890"},
    "contacts":[{"profile":{"name":"Test Customer"}}],
    "messages":[{"from":"94770000000","text":{"body":"Hi, is this available?"}}]
  }}]}]
}'
```

For this to create a lead in *your* account, first connect that
`phone_number_id` to your business from the Integrations tab (or via the
API — see `routes/webhooks.js`).

## 3. Deploy it so it's live on the internet

Meta's webhooks require a **public HTTPS URL** — they can't reach your
laptop. Easiest free options:

**Railway** (recommended, easiest):
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Set environment variables: `JWT_SECRET` (any long random string), `META_VERIFY_TOKEN` (a string you make up)
4. Railway gives you a public URL like `https://yourapp.up.railway.app`

**Render** works the same way (render.com → New Web Service → connect repo).

By default this runs on SQLite (zero setup, one file, fine for early testing).
For real production use with multiple businesses, switch to PostgreSQL —
see the next section.

## Deploying with PostgreSQL (recommended for production)

SQLite is a single file with one writer at a time — fine for local
development, not a good fit once multiple businesses/staff are hitting the
CRM concurrently. Switching to Postgres needs exactly two steps, no code
changes:

1. **Provision a Postgres database.** Railway and Render both offer this
   with one click ("New → PostgreSQL"). Copy the connection string it gives
   you (looks like `postgres://user:pass@host:5432/dbname`).
2. **Set two things on your deployed server:**
   ```
   DATABASE_URL=<the connection string from step 1>
   ```
   and install the one additional package this needs:
   ```bash
   npm install pg
   ```
   That's it — `db.js` detects `DATABASE_URL` automatically and switches
   backends. Every query in the app is written once and works unchanged on
   both engines (see `db.js` for how — it's a small, deliberately boring
   abstraction, not an ORM).

**Important — this was built and tested against SQLite only.** There's no
internet access in the sandbox that built this project, so the Postgres
path could not be run against a real Postgres server here. The SQL itself
avoids SQLite-only syntax on purpose (e.g. `ON CONFLICT` instead of
`INSERT OR REPLACE`, which is SQLite-specific and would fail on Postgres),
but you should still run this checklist once you deploy with a real
`DATABASE_URL`, before trusting it with real customer data:

- [ ] Server starts and logs `(database: PostgreSQL)` — confirms it picked up `DATABASE_URL`
- [ ] Sign up a business, log in
- [ ] Create a lead manually, confirm it appears in the Leads list
- [ ] Create the same lead again with a differently-formatted phone number — confirm it's caught as a duplicate, not created twice
- [ ] Simulate a webhook (the curl command in section 2 above) — confirm it creates a lead and appears on the Dashboard
- [ ] Connect the same channel account ID twice — confirm the second call doesn't error (this exercises the `ON CONFLICT` upsert path)
- [ ] Click Contacted on a lead 6+ times — confirm it stops scheduling new reminders after the 6th
- [ ] Sign up a second business, confirm it cannot see the first business's leads

If anything on that list behaves differently than on SQLite, it's almost
certainly a Postgres-specific SQL quirk in one query — much easier to spot
and fix against that specific checklist item than by reading the whole
codebase.

## 4. Connect real WhatsApp / Facebook / Instagram

This is the part that needs your own accounts — I can't create these for
you:

1. Create a [Meta for Developers](https://developers.facebook.com) account and an "app"
2. Add the **WhatsApp** product → it gives you a test phone number and a `phone_number_id`
3. Under WhatsApp → Configuration → set the webhook URL to
   `https://yourapp.up.railway.app/api/webhooks/whatsapp` and the verify
   token to whatever you set as `META_VERIFY_TOKEN`
4. Repeat similarly for **Facebook Lead Ads** (webhook: `/api/webhooks/facebook`)
   and **Instagram messaging** (webhook: `/api/webhooks/instagram`) — same app, additional products
5. In your Threadline dashboard → Integrations, paste in each account's ID so incoming webhooks route to your business
6. To actually send the auto-reply (not just log it), fill in the commented-out `fetch()` call in `sendAutoReply()` inside `routes/webhooks.js` with your WhatsApp access token

Meta requires app review before these work for anyone other than test
numbers/accounts you've added yourself — expect that process to take some
days to weeks depending on the product.

## Project structure

```
server.js           — HTTP server + routing (no Express, built-in http module)
db.js                — SQLite schema (businesses, users, leads, history, channel_accounts)
lib/auth.js           — password hashing + login tokens (no bcrypt/jsonwebtoken needed)
routes/auth.js        — signup/login
routes/leads.js        — CRUD for leads, history, follow-ups
routes/webhooks.js      — WhatsApp/Facebook/Instagram inbound handlers + auto-reply
public/index.html      — the dashboard (signup/login + inbox + follow-ups + integrations)
```

## Leads module

- **Leads tab** in the nav — add leads manually, or import a whole Excel file (`.xlsx`/`.xls`/`.csv`). Parsing happens in the browser (SheetJS via CDN) — the file never has to be uploaded as a raw file, just the parsed rows.
- **Duplicate prevention**: leads are matched by the last 9 digits of their phone number, so `077 998 4432`, `+94 77 998 4432`, and `94779984432` are all recognized as the same customer — whether added manually, imported, or messaged in via a webhook. Duplicates are skipped, not overwritten.
- **Quick status buttons** (Busy / Interested / Not Interested) on every lead in the Leads list.
- **Contacted button**: marks the current follow-up as done, counts toward a maximum of **6 follow-ups per customer**, and automatically schedules the next one (using your configured follow-up period) unless the cap has been reached.
- **Every inbound message** (WhatsApp/Facebook/Instagram) automatically (re)creates a follow-up reminder for that customer — whether they're brand new or already existed — so "New Leads Today" always reflects distinct customers, not message count.
- Dashboard's "Due for follow-up" list only shows customers who haven't had Contacted clicked since their reminder came due.

**Known limitation**: "new leads today" and follow-up due dates currently use UTC calendar days — see the earlier note about timezone if your team isn't in UTC.

## Social media connection methods

### WhatsApp — official Business Platform (Cloud API) only
The product now uses only Meta's official WhatsApp Business Platform —
registered directly with Meta, no QR code, no ToS risk, no ban risk. This
is the right choice for a production CRM you're deploying for real clients.
Setup: Settings → WhatsApp Business Platform → paste the `phone_number_id`
from your Meta developer dashboard, and point that number's webhook to
`/api/webhooks/whatsapp` on your deployed server (see "Connect real
WhatsApp / Facebook / Instagram" below for the full Meta-side steps).

**A smoother connect experience for later:** Meta also offers "WhatsApp
Embedded Signup" — a popup-based flow (similar to the Facebook OAuth button
below) that lets a business connect their number without manually copying a
phone_number_id. It requires additional Meta app permissions
(`whatsapp_business_management`) and app review, so it wasn't built in this
pass, but it's the natural next upgrade if the manual ID entry feels like
too much friction for your users.

**Note on the QR-code (unofficial) option**: earlier in this project's
history, an unofficial QR-linking option (via Baileys, mimicking WhatsApp
Web) was built and then intentionally removed from the product once the
project's requirements shifted to "production-grade, Meta-compliant."
The code still exists at `whatsapp/qr-session.js` and its API routes are
still present in `server.js`, but nothing in the UI links to it anymore —
it's inert. Delete that file and its routes if you want it gone entirely,
or leave it as reference; either is safe.

### Facebook & Instagram — real OAuth login
Clicking "Continue with Facebook" sends the browser to `facebook.com`
itself to log in — this server never sees a password, only a token Meta
issues back. Instagram connects through the same flow: a Facebook Page's
linked Instagram professional account, not a separate Instagram login (Meta
doesn't offer one for third-party apps).

To enable, create an app at [developers.facebook.com](https://developers.facebook.com)
and set these environment variables:
```
META_APP_ID=<your app id>
META_APP_SECRET=<your app secret>
PUBLIC_BASE_URL=https://yourapp.up.railway.app
```
In the Meta app's settings, add `https://yourapp.up.railway.app/api/oauth/facebook/callback`
as a valid OAuth redirect URI. Untested against Meta's live servers in this
build (no internet in the sandbox that built this) — the flow follows
Meta's documented OAuth spec, so test it end-to-end once you have real
credentials and a deployed URL.

## Follow-up reminder feature

- **Settings → Follow-up period**: pick 3 days, 5 days, or a custom number. Saved per-business via `PATCH /api/me`.
- **Settings → Staff**: add/remove staff names; assign any lead to one of them from the lead detail panel.
- **Dashboard** (now the default landing page) shows:
  - New leads received today
  - How many leads are currently due for follow-up
  - A list of those leads — name, phone, assigned staff, and how overdue/soon their follow-up is
- The follow-up date resets automatically to "N days from now" (using your configured period) whenever a call is logged on a lead — no manual math required.
- New leads captured via any webhook are automatically given a follow-up date `N` days out, using whatever period is currently configured.

## Known gaps / good next steps

- **One user per business** — fine for a solo owner; add a `role` column to `users` if you want to invite teammates with different permission levels.
- **No billing** — only needed if you're charging other companies to use this.
- **SQLite file lives on the server's disk if you don't set `DATABASE_URL`** — fine for early testing, but move to Postgres (see above) before real production use, especially on hosts that wipe disk on redeploy.
- **Mobile layout** — the Dashboard, Leads, Inbox, and Settings pages all have a responsive breakpoint (sidebar becomes a bottom nav, split views stack vertically, cards wrap), but this was visually tuned by reading the CSS carefully rather than tested on a real phone/browser (no browser available in the sandbox that built this) — worth a quick pass on an actual device before shipping to end users.
- **WhatsApp connect UX** — still a manual `phone_number_id` paste rather than a one-click flow; Meta's "Embedded Signup" would fix that (see the WhatsApp section above) but needs additional app review.
