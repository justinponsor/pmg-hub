module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({
    status: 'online',
    replicate: !!process.env.REPLICATE_API_TOKEN,
    storage: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    replicateToken: process.env.REPLICATE_API_TOKEN || '',
    version: '1.0.0',
  });
}
