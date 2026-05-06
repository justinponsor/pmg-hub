// api/axel-create.js — Full Axel pipeline
// trim → merge → mmaudio (AI music) → autocaption → store in Supabase
const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 300;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.REPLICATE_API_TOKEN) return res.status(503).json({ error: 'REPLICATE_API_TOKEN not configured' });

  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;

  async function run(model, input) {
    console.log(`Running ${model}...`);
    const out = await replicate.run(model, { input });
    if (!out) throw new Error(`${model} returned null`);
    const url = typeof out === 'string' ? out
      : out?.url?.href || out?.url || out?.output || (Array.isArray(out) ? out[0] : null);
    if (!url) throw new Error(`${model} returned no URL: ${JSON.stringify(out).slice(0,200)}`);
    console.log(`${model} → ${url}`);
    return url;
  }

  try {
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');
    const format = body.format || 'reel';

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });
    console.log(`Axel: ${clipUrls.length} clips, ${targetLength}s, music:${musicSource}`);

    // ── STEP 1: Trim each clip ──
    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));
    const trimmedUrls = [];
    for (let i = 0; i < clipUrls.length; i++) {
      try {
        const url = await run(
          'lucataco/trim-video:ad40a08da114637a031125d4546de17e34892f17',
          { video_url: clipUrls[i], start_time: 0, end_time: trimDuration }
        );
        trimmedUrls.push(url);
      } catch(e) {
        console.log(`Trim ${i+1} failed: ${e.message} — using original`);
        trimmedUrls.push(clipUrls[i]);
      }
    }

    // ── STEP 2: Merge clips ──
    let videoUrl = trimmedUrls[0];
    for (let i = 1; i < trimmedUrls.length; i++) {
      try {
        videoUrl = await run(
          'lucataco/video-merge:e522fe6d876a0a61cc8da9b5e60aee8bba41c21ee02fc85ca2f7b01fc3e73abb',
          { video_url_1: videoUrl, video_url_2: trimmedUrls[i] }
        );
      } catch(e) {
        console.log(`Merge ${i} failed: ${e.message}`);
      }
    }
    console.log('After merge:', videoUrl);

    // ── STEP 3: AI Music with mmaudio ──
    if (musicSource === 'ai') {
      try {
        const musicVibe = style.musicvibe || 'high energy';
        videoUrl = await run(
          'zsxkib/mmaudio:4b9f801a1bdc3a8b5e18c5032ff3c3b59b37ec8ef7dd8d76c97ddc8e14a25cb5',
          {
            video: videoUrl,
            prompt: `${musicVibe} background music. ${brief}`,
            negative_prompt: 'speech, talking, vocals',
            seed: -1,
            num_steps: 25,
            duration: targetLength,
            cfg_strength: 4.5,
          }
        );
      } catch(e) {
        console.log('mmaudio failed:', e.message);
      }
    }

    // ── STEP 4: Captions ──
    if (style.caps && style.caps !== 'No captions') {
      try {
        videoUrl = await run(
          'fictions-ai/autocaption:3c5b8e7f6d5c4b3a2e1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9',
          {
            video_file_input: videoUrl,
            font: 'Montserrat-Bold',
            font_size: 40,
            stroke_width: 2,
            color: 'white',
            stroke_color: 'black',
            subs_position: 'bottom75',
            highlight_color: 'yellow',
          }
        );
      } catch(e) {
        console.log('Autocaption failed:', e.message);
      }
    }

    // ── STEP 5: Store final video in Supabase ──
    if (supabase && videoUrl && !videoUrl.includes('supabase.co')) {
      try {
        const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
        const fileName = `exports/axel_${Date.now()}.mp4`;
        await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
        const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);
        videoUrl = publicUrl;

        // Clean up raw clips
        for (const clipUrl of clipUrls) {
          try {
            const path = clipUrl.split('/axel-videos/')[1];
            if (path) await supabase.storage.from('axel-videos').remove([path]);
          } catch(e) {}
        }

        // Save record
        await supabase.from('axel_exports').insert({
          brief, format, duration: targetLength,
          style: JSON.stringify(style), clip_count: clipUrls.length,
          video_url: videoUrl, created_at: new Date().toISOString(),
        }).catch(() => {});

        console.log('Stored in Supabase:', videoUrl);
      } catch(e) {
        console.log('Storage failed:', e.message);
      }
    }

    console.log('Axel complete:', videoUrl);
    return res.status(200).json({
      success: true, videoUrl,
      clipsProcessed: clipUrls.length,
      duration: targetLength, format,
    });

  } catch(err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
