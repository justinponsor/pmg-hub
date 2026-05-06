// api/axel-create.js — Full Axel pipeline with detailed logging
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

  const log = (...args) => console.log('[Axel]', ...args);

  try {
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');
    const format = body.format || 'reel';

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });
    log(`Starting: ${clipUrls.length} clips, ${targetLength}s, music:${musicSource}`);
    clipUrls.forEach((u,i) => log(`Clip ${i+1}: ${u}`));

    // ── STEP 1: Trim each clip ──
    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));
    log(`Trimming each clip to ${trimDuration}s`);
    const trimmedUrls = [];

    for (let i = 0; i < clipUrls.length; i++) {
      log(`Trimming clip ${i+1}: ${clipUrls[i]}`);
      try {
        const out = await replicate.run(
          'lucataco/trim-video:ad40a08da114637a031125d4546de17e34892f17',
          { input: { video_url: clipUrls[i], start_time: 0, end_time: trimDuration } }
        );
        log(`Trim ${i+1} raw output:`, JSON.stringify(out).slice(0,200));
        const url = typeof out === 'string' ? out : out?.url?.href || out?.url || (Array.isArray(out) ? out[0] : null);
        if (url) {
          trimmedUrls.push(url);
          log(`Trim ${i+1} success: ${url}`);
        } else {
          log(`Trim ${i+1} no URL in output, using original`);
          trimmedUrls.push(clipUrls[i]);
        }
      } catch(e) {
        log(`Trim ${i+1} ERROR: ${e.message}`);
        trimmedUrls.push(clipUrls[i]);
      }
    }

    // ── STEP 2: Merge clips ──
    let videoUrl = trimmedUrls[0];
    log(`Merging ${trimmedUrls.length} clips...`);

    for (let i = 1; i < trimmedUrls.length; i++) {
      log(`Merging clip ${i+1} into result...`);
      try {
        const out = await replicate.run(
          'lucataco/video-merge:e522fe6d876a0a61cc8da9b5e60aee8bba41c21ee02fc85ca2f7b01fc3e73abb',
          { input: { video_url_1: videoUrl, video_url_2: trimmedUrls[i] } }
        );
        log(`Merge ${i} raw output:`, JSON.stringify(out).slice(0,200));
        const url = typeof out === 'string' ? out : out?.url?.href || out?.url || (Array.isArray(out) ? out[0] : null);
        if (url) {
          videoUrl = url;
          log(`Merge ${i} success: ${videoUrl}`);
        } else {
          log(`Merge ${i} no URL in output`);
        }
      } catch(e) {
        log(`Merge ${i} ERROR: ${e.message}`);
      }
    }
    log(`After merge: ${videoUrl}`);

    // ── STEP 3: AI Music with mmaudio ──
    if (musicSource === 'ai') {
      log('Adding AI music with mmaudio...');
      try {
        const musicVibe = style.musicvibe || 'high energy';
        const out = await replicate.run(
          'zsxkib/mmaudio:4b9f801a1bdc3a8b5e18c5032ff3c3b59b37ec8ef7dd8d76c97ddc8e14a25cb5',
          { input: {
            video: videoUrl,
            prompt: `${musicVibe} background music. ${brief}`,
            negative_prompt: 'speech, talking, vocals',
            seed: -1,
            num_steps: 25,
            duration: targetLength,
            cfg_strength: 4.5,
          }}
        );
        log('mmaudio raw output:', JSON.stringify(out).slice(0,200));
        const url = typeof out === 'string' ? out : out?.url?.href || out?.url || (Array.isArray(out) ? out[0] : null);
        if (url) {
          videoUrl = url;
          log('Music added:', videoUrl);
        } else {
          log('mmaudio no URL in output');
        }
      } catch(e) {
        log('mmaudio ERROR:', e.message);
      }
    }

    // ── STEP 4: Store in Supabase ──
    if (supabase && videoUrl && !videoUrl.includes('supabase.co')) {
      try {
        log('Storing in Supabase...');
        const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
        const fileName = `exports/axel_${Date.now()}.mp4`;
        await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
        const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);
        videoUrl = publicUrl;

        // Clean up raw clips to save space
        for (const clipUrl of clipUrls) {
          try {
            const path = decodeURIComponent(clipUrl.split('/axel-videos/')[1]);
            if (path) await supabase.storage.from('axel-videos').remove([path]);
          } catch(e) {}
        }

        await supabase.from('axel_exports').insert({
          brief, format, duration: targetLength,
          style: JSON.stringify(style), clip_count: clipUrls.length,
          video_url: videoUrl, created_at: new Date().toISOString(),
        }).catch(() => {});
        log('Stored:', videoUrl);
      } catch(e) {
        log('Storage ERROR:', e.message);
      }
    }

    log('COMPLETE:', videoUrl);
    return res.status(200).json({
      success: true, videoUrl,
      clipsProcessed: clipUrls.length,
      duration: targetLength, format,
    });

  } catch(err) {
    console.error('[Axel] FATAL:', err);
    return res.status(500).json({ error: err.message });
  }
}
