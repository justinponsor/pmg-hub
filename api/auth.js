export default function handler(req, res) {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  const { client } = req.query;

  const scope = [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'pages_manage_engagement',
    'business_management',
  ].join(',');

  const state = Buffer.from(JSON.stringify({ client })).toString('base64');

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&response_type=code`;

  res.redirect(authUrl);
}
