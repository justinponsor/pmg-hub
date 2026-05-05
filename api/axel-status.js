// api/axel-status.js
// Deploy this to /api/axel-status.js in your GitHub repo

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const hasReplicate = !!process.env.REPLICATE_API_TOKEN;
  const hasStorage = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY);

  res.status(200).json({
    status: 'online',
    replicate: hasReplicate,
    storage: hasStorage,
    version: '1.0.0',
  });
}
