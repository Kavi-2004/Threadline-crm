require('dotenv').config();

const crypto = require('node:crypto');
const db = require('../db');
const { signToken, verifyToken } = require('../lib/auth');

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL;

// Facebook permissions only
const SCOPES = [
  'public_profile',
  'email',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging'
].join(',');

function notConfigured() {
  return {
    status: 500,
    html: `
      <div style="font-family:sans-serif;padding:40px;">
        <h2>Meta App is not configured.</h2>

        <p>Please configure these Railway Variables:</p>

<pre>
META_APP_ID=
META_APP_SECRET=
PUBLIC_BASE_URL=
</pre>

      </div>
    `
  };
}

function startFacebookLogin(query) {

  if (!APP_ID || !APP_SECRET || !BASE_URL)
    return notConfigured();

  const payload = verifyToken(query.token || '');

  if (!payload) {
    return {
      status: 401,
      html: "<h3>Session expired. Please login again.</h3>"
    };
  }

  const state = signToken({
    businessId: payload.businessId,
    purpose: 'oauth-facebook'
  }, 600);

  const redirectUri =
    `${BASE_URL}/api/oauth/facebook/callback`;

  const loginUrl =
    `https://www.facebook.com/v20.0/dialog/oauth` +
    `?client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&scope=${encodeURIComponent(SCOPES)}`;

  return {
    status: 302,
    redirect: loginUrl
  };

}

async function handleFacebookCallback(query){

  if (!APP_ID || !APP_SECRET || !BASE_URL)
    return notConfigured();

  const state = verifyToken(query.state || '');

  if (!state || state.purpose !== 'oauth-facebook') {
    return {
      status: 400,
      html: "Invalid OAuth state."
    };
  }

  if(query.error){

    return{
      status: 400,
      html:`Facebook Login Failed : ${query.error}`
    };

  }

  const redirectUri =
    `${BASE_URL}/api/oauth/facebook/callback`;

  try{

    //---------------------------------------
    // Exchange Code For User Token
    //---------------------------------------

    const tokenResponse = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${query.code}`
    );

    const tokenData = await tokenResponse.json();

    if(!tokenData.access_token){

      throw new Error(
        tokenData.error?.message ||
        "Unable to access token."
      );

    }

    //---------------------------------------
    // Get Facebook Pages
    //---------------------------------------

    const pagesResponse = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${tokenData.access_token}`
    );

    const pagesJson = await pagesResponse.json();

    const pages = pagesJson.data || [];

    for(const page of pages){

      //-----------------------------------
      // Save Facebook Page
      //-----------------------------------

      await db.run(
        `INSERT INTO channel_accounts
        (id,business_id,channel,account_id)
        VALUES(?,?,?,?)
        ON CONFLICT(channel,account_id)
        DO UPDATE SET
        business_id=excluded.business_id`,
        [
          crypto.randomUUID(),
          state.businessId,
          'facebook',
          page.id
        ]
      );

      await db.run(
        `INSERT INTO channel_tokens
        (channel_account_key,access_token)
        VALUES(?,?)
        ON CONFLICT(channel_account_key)
        DO UPDATE SET
        access_token=excluded.access_token`,
        [
          `facebook:${page.id}`,
          page.access_token
        ]
      );

      //-----------------------------------
      // Save Instagram Business Account
      //-----------------------------------

      if(page.instagram_business_account){

        const igId = page.instagram_business_account.id;

        await db.run(
          `INSERT INTO channel_accounts
          (id,business_id,channel,account_id)
          VALUES(?,?,?,?)
          ON CONFLICT(channel,account_id)
          DO UPDATE SET
          business_id=excluded.business_id`,
          [
            crypto.randomUUID(),
            state.businessId,
            'instagram',
            igId
          ]
        );

        await db.run(
          `INSERT INTO channel_tokens
          (channel_account_key,access_token)
          VALUES(?,?)
          ON CONFLICT(channel_account_key)
          DO UPDATE SET
          access_token=excluded.access_token`,
          [
            `instagram:${igId}`,
            page.access_token
          ]
        );

      }

    }

    // සාර්ථකව සම්බන්ධ වූ පසු ස්වයංක්‍රීයව CRM ඩෑෂ්බෝඩ් එක වෙත Redirect වීම
    return {
      status: 302,
      redirect: '/index.html' // හෝ ඔබේ CRM ඩෑෂ්බෝඩ් ලින්ක් එක
    };

  }

  catch(err){

    return{
      status: 500,
      html: `
        <div style="font-family:sans-serif;padding:40px;">
          <h2>Connection Failed</h2>
          <p>${err.message}</p>
        </div>
      `
    };

  }

}

module.exports = {
  startFacebookLogin,
  handleFacebookCallback
};