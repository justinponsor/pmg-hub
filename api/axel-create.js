// api/axel-create.js
// Clips are uploaded directly from browser to Supabase
// This API receives clip URLs and orchestrates AI processing

const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.REPLICATE_API_TOKEN)
    return res.status(503).json({ error: 'REPLICATE_API_TOKEN not configured' });

  try {
    // Parse JSON or form body
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const format = body.format || 'reel';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const supabase = process.env.SUPABASE_URL
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      : null;

    // Generate AI music
    let musicUrl = null;
    if (musicSource === 'ai') {
      try {
        musicUrl = await replicate.run(
          'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837ffe9f2',
          { input: {
            prompt: `${style.musicvibe || 'high energy'} instrumental background music for a ${targetLength}s social media video about: ${brief}. No vocals.`,
            model_version: 'stereo-melody-large',
            output_format: 'mp3',
            duration: targetLength,
          }}
        );
      } catch(e) { console.log('Music gen skipped:', e.message); }
    }

    // For now return the first clip URL + music
    // Full video editing pipeline to be added in v2
    const videoUrl = clipUrls[0];

    // Save export record if Supabase configured
    if (supabase) {
      try {
        await supabase.from('axel_exports').insert({
          brief, format,
          duration: targetLength,
          style: JSON.stringify(style),
          clip_urls: JSON.stringify(clipUrls),
          video_url: videoUrl,
          music_url: musicUrl,
          created_at: new Date().toISOString(),
        });
      } catch(e) { console.log('DB save skipped:', e.message); }
    }

    return res.status(200).json({
      success: true,
      videoUrl,
      musicUrl,
      duration: targetLength,
      format,
      clipsProcessed: clipUrls.length,
    });

  } catch (err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
