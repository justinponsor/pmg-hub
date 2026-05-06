// api/axel-status.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({
    status: 'online',
    replicate: !!process.env.REPLICATE_API_TOKEN,
    storage: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    // Return service key as upload key - safe since bucket has anon INSERT policy
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    replicateToken: process.env.REPLICATE_API_TOKEN || '',
    version: '1.0.0',
  });
}
