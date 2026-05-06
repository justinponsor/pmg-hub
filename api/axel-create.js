// api/axel-create.js — Full Axel pipeline
// trim → merge → mmaudio (AI music) → autocaption → store
// Requires Vercel Pro (300s timeout)

const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');

// Vercel Pro: extend to 300 seconds
export const maxDuration = 300;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.REPLICATE_API_TOKEN) return res.status(503).json({ error: 'REPLICATE_API_TOKEN not configured' });

  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;

  try {
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');
    const format = body.format || 'reel';

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });
    console.log(`Axel: ${clipUrls.length} clips, ${targetLength}s, format: ${format}`);

    // ── STEP 1: Trim each clip ──
    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));
    const trimmedUrls = [];
    for (let i = 0; i < clipUrls.length; i++) {
      console.log(`Trimming clip ${i+1}/${clipUrls.length} to ${trimDuration}s`);
      try {
        const out = await replicate.run('lucataco/trim-video', {
          input: { video_url: clipUrls[i], start_time: 0, end_time: trimDuration }
        });
        trimmedUrls.push(typeof out === 'string' ? out : out?.url || clipUrls[i]);
      } catch(e) {
        console.log(`Trim ${i+1} failed:`, e.message);
        trimmedUrls.push(clipUrls[i]);
      }
    }

    // ── STEP 2: Merge clips ──
    let videoUrl = trimmedUrls[0];
    if (trimmedUrls.length > 1) {
      console.log('Merging clips...');
      try {
        // video-merge takes two clips at a time; chain for multiple
        let merged = trimmedUrls[0];
        for (let i = 1; i < trimmedUrls.length; i++) {
          const out = await replicate.run('lucataco/video-merge', {
            input: { video_url_1: merged, video_url_2: trimmedUrls[i] }
          });
          merged = typeof out === 'string' ? out : out?.url || merged;
        }
        videoUrl = merged;
        console.log('Merged:', videoUrl);
      } catch(e) {
        console.log('Merge failed:', e.message);
      }
    }

    // ── STEP 3: AI Music with mmaudio ──
    if (musicSource === 'ai') {
      console.log('Adding AI music with mmaudio...');
      try {
        const musicVibe = style.musicvibe || 'high energy';
        const out = await replicate.run('zsxkib/mmaudio', {
          input: {
            video: videoUrl,
            prompt: `${musicVibe} background music. ${brief}`,
            negative_prompt: 'speech, talking, vocals',
            seed: -1,
            num_steps: 25,
            duration: targetLength,
            cfg_strength: 4.5,
            mask_away_clip: false,
          }
        });
        if (out) {
          videoUrl = typeof out === 'string' ? out : out?.url || out?.video || videoUrl;
          console.log('Music added:', videoUrl);
        }
      } catch(e) {
        console.log('Music failed:', e.message);
      }
    }

    // ── STEP 4: Captions ──
    if (style.caps && style.caps !== 'No captions') {
      console.log('Adding captions...');
      try {
        const out = await replicate.run('fictions-ai/autocaption', {
          input: {
            video_file_input: videoUrl,
            font: 'Montserrat-Bold',
            font_size: style.caps === 'Minimal' ? 30 : 40,
            stroke_width: style.caps === 'Minimal' ? 1 : 2,
            color: 'white',
            stroke_color: 'black',
            subs_position: 'bottom75',
            highlight_color: style.caps === 'Bold & centered' ? 'yellow' : 'white',
          }
        });
        if (out) {
          videoUrl = typeof out === 'string' ? out : out?.url || videoUrl;
          console.log('Captions added:', videoUrl);
        }
      } catch(e) {
        console.log('Captions failed:', e.message);
      }
    }

    // ── STEP 5: Store in Supabase ──
    if (supabase && videoUrl && !videoUrl.includes('supabase.co')) {
      try {
        console.log('Storing in Supabase...');
        const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
        const fileName = `exports/axel_${Date.now()}.mp4`;
        await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
        const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);
        videoUrl = publicUrl;
        await supabase.from('axel_exports').insert({
          brief, format, duration: targetLength,
          style: JSON.stringify(style), clip_count: clipUrls.length,
          video_url: videoUrl, created_at: new Date().toISOString(),
        }).catch(() => {});
        console.log('Stored:', videoUrl);
      } catch(e) {
        console.log('Storage failed, returning Replicate URL:', e.message);
      }
    }

    return res.status(200).json({ success: true, videoUrl, clipsProcessed: clipUrls.length, duration: targetLength, format });

  } catch(err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
