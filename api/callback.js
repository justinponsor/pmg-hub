export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?error=auth_denied');
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;

  try {
    // Exchange code for short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      return res.redirect('/?error=token_failed');
    }

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`
    );
    const longData = await longRes.json();

    // Get pages list
    const pagesRes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${longData.access_token}`
    );
    const pagesData = await pagesRes.json();

    // Decode state to get client name
    const { client } = JSON.parse(Buffer.from(state, 'base64').toString());

    // Return token info to frontend
    const result = {
      client,
      userToken: longData.access_token,
      pages: pagesData.data || [],
    };

    // Pass back to frontend via URL (in production use a database)
    const encoded = Buffer.from(JSON.stringify(result)).toString('base64');
    res.redirect(`/?connected=${encoded}`);

  } catch (err) {
    res.redirect('/?error=server_error');
  }
}
