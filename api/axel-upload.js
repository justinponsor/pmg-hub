// api/axel-upload.js
// Proxy endpoint: receives video file from browser, uploads to Replicate, returns URL
// This bypasses CORS since the server-side call is allowed

const { IncomingForm } = require('formidable');
const fs = require('fs');
const fetch = require('node-fetch');

module.exports.config = { api: { bodyParser: false } };
module.exports.maxDuration = 60;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.REPLICATE_API_TOKEN) return res.status(503).json({ error: 'No Replicate token' });

  try {
    const form = new IncomingForm({ maxFileSize: 500 * 1024 * 1024 });
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const buffer = fs.readFileSync(file.filepath);
    const { FormData, Blob } = require('formdata-node');
    const fd = new FormData();
    fd.append('content', new Blob([buffer], { type: file.mimetype || 'video/mp4' }), file.originalFilename || 'clip.mp4');

    const uploadRes = await fetch('https://api.replicate.com/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}` },
      body: fd,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(uploadRes.status).json({ error: `Replicate upload failed: ${err}` });
    }

    const data = await uploadRes.json();
    const fileUrl = data.urls?.source || data.url || data.id;
    return res.status(200).json({ success: true, url: fileUrl });

  } catch (err) {
    console.error('Upload proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
