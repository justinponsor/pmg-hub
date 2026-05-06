// api/axel-create.js
const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');
const formidable = require('formidable');
const fs = require('fs');

module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(503).json({ error: 'REPLICATE_API_TOKEN not configured' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const form = formidable({ multiples: true, maxFileSize: 500 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const brief = fields.brief?.[0] || '';
    const format = fields.format?.[0] || 'reel';
    const targetLength = parseInt(fields.length?.[0]) || 30;
    const musicSource = fields.music_source?.[0] || 'ai';
    const style = JSON.parse(fields.style?.[0] || '{}');

    const clips = Object.keys(files).filter(k => k.startsWith('clip_'))
      .map(k => Array.isArray(files[k]) ? files[k][0] : files[k]);

    if (!clips.length) return res.status(400).json({ error: 'No clips provided' });

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Upload clips to Supabase
    const clipUrls = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const buffer = fs.readFileSync(clip.filepath);
      const fileName = `clips/${Date.now()}_${i}_${clip.originalFilename || 'clip.mp4'}`;
      const { error } = await supabase.storage.from('axel-videos').upload(fileName, buffer, {
        contentType: clip.mimetype || 'video/mp4',
      });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);
      clipUrls.push(publicUrl);
    }

    // Generate AI music
    let musicUrl = null;
    if (musicSource === 'ai') {
      try {
        musicUrl = await replicate.run(
          'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837ffe9f2',
          { input: {
            prompt: `${style.musicvibe || 'high energy'} instrumental background music for a ${targetLength}s social media video. ${brief}`,
            model_version: 'stereo-melody-large',
            output_format: 'mp3',
            duration: targetLength,
          }}
        );
      } catch(e) { console.log('Music gen skipped:', e.message); }
    }

    // Return result
    return res.status(200).json({
      success: true,
      videoUrl: clipUrls[0],
      musicUrl,
      duration: targetLength,
      format,
      message: 'Clips uploaded successfully. Full video rendering coming in next update.',
    });

  } catch (err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
