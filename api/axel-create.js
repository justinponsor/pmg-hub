// api/axel-create.js
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
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const format = body.format || 'reel';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });

    const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      : null;

    // Generate AI music asynchronously - don't wait for it (takes too long for Vercel)
    // Start the prediction and return the prediction ID for polling
    let musicPredictionId = null;
    if (musicSource === 'ai') {
      try {
        const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
        // Create prediction without waiting
        const prediction = await replicate.predictions.create({
          version: '671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837ffe9f2',
          input: {
            prompt: `${style.musicvibe || 'high energy'} instrumental background music for ${targetLength}s social media video. ${brief}. No vocals.`,
            model_version: 'stereo-melody-large',
            output_format: 'mp3',
            duration: targetLength,
          }
        });
        musicPredictionId = prediction.id;
      } catch(e) {
        console.log('Music prediction start failed:', e.message);
      }
    }

    // Save to DB
    if (supabase) {
      try {
        await supabase.from('axel_exports').insert({
          brief, format, duration: targetLength,
          style: JSON.stringify(style),
          clip_urls: JSON.stringify(clipUrls),
          video_url: clipUrls[0],
          music_prediction_id: musicPredictionId,
          created_at: new Date().toISOString(),
        });
      } catch(e) { console.log('DB save skipped:', e.message); }
    }

    return res.status(200).json({
      success: true,
      videoUrl: clipUrls[0],
      musicPredictionId,
      duration: targetLength,
      format,
      clipsProcessed: clipUrls.length,
      message: musicPredictionId ? 'Music generating - poll /api/axel-music-status for result' : null,
    });

  } catch (err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
