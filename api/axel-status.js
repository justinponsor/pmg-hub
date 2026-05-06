// api/axel-status.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    status: 'online',
    replicate: !!process.env.REPLICATE_API_TOKEN,
    storage: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    version: '1.0.0',
  });
}
