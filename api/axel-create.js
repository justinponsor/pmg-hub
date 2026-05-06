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

  // Helper: poll a prediction until it succeeds or fails
  async function waitForPrediction(prediction) {
    let pred = prediction;
    while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
      await new Promise(r => setTimeout(r, 3000));
      pred = await replicate.predictions.get(pred.id);
      log(`  polling ${pred.id}: ${pred.status}`);
    }
    if (pred.status !== 'succeeded') throw new Error(`Prediction ${pred.id} ${pred.status}: ${JSON.stringify(pred.error)}`);
    return pred.output;
  }

  // Helper: extract URL from replicate output (handles string, object, array)
  function extractUrl(out) {
    if (!out) return null;
    if (typeof out === 'string') return out;
    if (out?.url?.href) return out.url.href;
    if (out?.url) return out.url;
    if (Array.isArray(out) && out[0]) return typeof out[0] === 'string' ? out[0] : out[0]?.url?.href || out[0]?.url || null;
    return null;
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
    log(`Starting: ${clipUrls.length} clips, ${targetLength}s, music:${musicSource}`);
    clipUrls.forEach((u, i) => log(`Clip ${i + 1}: ${u}`));

    // ── STEP 1: Trim each clip ──
    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));
    log(`Trimming each clip to ${trimDuration}s`);
    const trimmedUrls = [];

    for (let i = 0; i < clipUrls.length; i++) {
      log(`Trimming clip ${i + 1}: ${clipUrls[i]}`);
      try {
        // Use latest version hash (updated May 2026)
        const pred = await replicate.predictions.create({
          version: 'a58ed80215326cba0a80c77a11dd0d0968c567388228891b3c5c67de2a8d10cb',
          input: { video_url: clipUrls[i], start_time: 0, end_time: trimDuration }
        });
        const out = await waitForPrediction(pred);
        log(`Trim ${i + 1} raw output:`, JSON.stringify(out).slice(0, 200));
        const url = extractUrl(out);
        if (url) {
          trimmedUrls.push(url);
          log(`Trim ${i + 1} success: ${url}`);
        } else {
          log(`Trim ${i + 1} no URL in output, using original`);
          trimmedUrls.push(clipUrls[i]);
        }
      } catch (e) {
        log(`Trim ${i + 1} ERROR: ${e.message}`);
        trimmedUrls.push(clipUrls[i]);
      }
    }

    // ── STEP 2: Merge clips ──
    let videoUrl = trimmedUrls[0];
    log(`Merging ${trimmedUrls.length} clips...`);

    for (let i = 1; i < trimmedUrls.length; i++) {
      log(`Merging clip ${i + 1} into result...`);
      try {
        // Use model name directly — Replicate resolves to latest version automatically
        const pred = await replicate.predictions.create({
          model: 'lucataco/video-merge',
          input: { video_url_1: videoUrl, video_url_2: trimmedUrls[i] }
        });
        const out = await waitForPrediction(pred);
        log(`Merge ${i} raw output:`, JSON.stringify(out).slice(0, 200));
        const url = extractUrl(out);
        if (url) {
          videoUrl = url;
          log(`Merge ${i} success: ${videoUrl}`);
        } else {
          log(`Merge ${i} no URL in output, keeping previous`);
        }
      } catch (e) {
        log(`Merge ${i} ERROR: ${e.message}`);
      }
    }
    log(`After merge: ${videoUrl}`);

    // ── STEP 3: AI Music with mmaudio ──
    if (musicSource === 'ai') {
      log('Adding AI music with mmaudio...');
      try {
        const musicVibe = style.musicvibe || 'high energy';
        const pred = await replicate.predictions.create({
          model: 'zsxkib/mmaudio',
          input: {
            video: videoUrl,
            prompt: `${musicVibe} background music. ${brief}`,
            negative_prompt: 'speech, talking, vocals',
            seed: -1,
            num_steps: 25,
            duration: targetLength,
            cfg_strength: 4.5,
          }
        });
        const out = await waitForPrediction(pred);
        log('mmaudio raw output:', JSON.stringify(out).slice(0, 200));
        const url = extractUrl(out);
        if (url) {
          videoUrl = url;
          log('Music added:', videoUrl);
        } else {
          log('mmaudio no URL in output');
        }
      } catch (e) {
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
          } catch (e) {}
        }

        await supabase.from('axel_exports').insert({
          brief, format, duration: targetLength,
          style: JSON.stringify(style), clip_count: clipUrls.length,
          video_url: videoUrl, created_at: new Date().toISOString(),
        }).catch(() => {});
        log('Stored:', videoUrl);
      } catch (e) {
        log('Storage ERROR:', e.message);
      }
    }

    log('COMPLETE:', videoUrl);
    return res.status(200).json({
      success: true, videoUrl,
      clipsProcessed: clipUrls.length,
      duration: targetLength, format,
    });

  } catch (err) {
    console.error('[Axel] FATAL:', err);
    return res.status(500).json({ error: err.message });
  }
}
