// api/axel-start.js — Uses fal.subscribe() to trim+merge synchronously (no 422 bug)
// fal.subscribe() handles polling internally and returns result directly

const { createClient } = require('@supabase/supabase-js');
const { fal } = require('@fal-ai/client');

module.exports.maxDuration = 300;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) return res.status(503).json({ error: 'FAL_KEY not configured' });
  fal.config({ credentials: FAL_KEY });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const log = (...a) => console.log('[Axel:start]', ...a);

  try {
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');
    const format = body.format || 'reel';

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });
    log(`Starting: ${clipUrls.length} clips, ${targetLength}s`);

    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));

    // ── STEP 1: Trim all clips in parallel using fal.subscribe ──
    log(`Trimming ${clipUrls.length} clips to ${trimDuration}s each...`);
    const trimResults = await Promise.all(
      clipUrls.map(async (url, i) => {
        try {
          log(`Trimming clip ${i + 1}...`);
          const result = await fal.subscribe('fal-ai/workflow-utilities/trim-video', {
            input: { video_url: url, start_time: 0, end_time: trimDuration },
          });
          const trimmedUrl = result.data?.video?.url;
          if (trimmedUrl) {
            log(`Clip ${i + 1} trimmed: ${trimmedUrl}`);
            return trimmedUrl;
          }
          log(`Clip ${i + 1} trim no URL, using original. data:`, JSON.stringify(result.data).slice(0, 200));
          return url;
        } catch(e) {
          log(`Clip ${i + 1} trim error: ${e.message}, using original`);
          return url;
        }
      })
    );
    log('All clips trimmed:', trimResults);

    // ── STEP 2: Merge all trimmed clips ──
    let mergedUrl = trimResults[0];
    if (trimResults.length > 1) {
      try {
        log('Merging clips...');
        const mergeResult = await fal.subscribe('fal-ai/ffmpeg-api/merge-videos', {
          input: { video_urls: trimResults },
        });
        const url = mergeResult.data?.video?.url || mergeResult.data?.url;
        if (url) {
          mergedUrl = url;
          log('Merged:', mergedUrl);
        } else {
          log('Merge no URL, using first clip. data:', JSON.stringify(mergeResult.data).slice(0, 200));
        }
      } catch(e) {
        log('Merge error:', e.message, '— using first trimmed clip');
      }
    }

    // ── STEP 3: Create job + kick off music ──
    const { data: job, error: insertError } = await supabase
      .from('axel_jobs')
      .insert({
        status: musicSource === 'ai' ? 'music' : 'storing',
        brief, format,
        target_length: targetLength,
        music_source: musicSource,
        style: JSON.stringify(style),
        clip_urls: JSON.stringify(clipUrls),
        trim_duration: trimDuration,
        trimmed_urls: JSON.stringify(trimResults),
        current_video_url: mergedUrl,
        final_url: musicSource !== 'ai' ? mergedUrl : null,
        created_at: new Date().toISOString(),
      })
      .select().single();

    if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`);
    log(`Job created: ${job.id}`);

    if (musicSource !== 'ai') {
      // No music — store directly
      await storeAndFinish(supabase, job, mergedUrl, clipUrls, log);
      return res.status(200).json({ jobId: job.id, status: 'storing' });
    }

    // Start mmaudio
    log('Starting mmaudio...');
    const styleObj = JSON.parse(body.style || '{}');
    const musicVibe = styleObj.musicvibe || 'high energy';
    const predRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'zsxkib/mmaudio',
        input: {
          video: mergedUrl,
          prompt: `${musicVibe} background music. ${brief}`,
          negative_prompt: 'speech, talking, vocals',
          seed: -1, num_steps: 25,
          duration: targetLength, cfg_strength: 4.5,
        },
      }),
    });
    const pred = await predRes.json();
    if (pred.id) {
      log('mmaudio started:', pred.id);
      await supabase.from('axel_jobs').update({
        replicate_prediction_id: JSON.stringify({ type: 'music', id: pred.id }),
      }).eq('id', job.id);
    } else {
      log('mmaudio failed, storing without music:', JSON.stringify(pred));
      await storeAndFinish(supabase, job, mergedUrl, clipUrls, log);
    }

    return res.status(200).json({ jobId: job.id, status: 'music' });

  } catch (err) {
    console.error('[Axel:start] FATAL:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function storeAndFinish(supabase, job, videoUrl, clipUrls, log) {
  try {
    log('Storing final video from:', videoUrl);
    const fetchResp = await fetch(videoUrl);
    if (!fetchResp.ok) throw new Error(`Fetch failed (${fetchResp.status})`);
    const buf = Buffer.from(await fetchResp.arrayBuffer());
    const fileName = `exports/axel_${Date.now()}.mp4`;
    const { error: uploadErr } = await supabase.storage
      .from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);
    const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);
    await supabase.from('axel_jobs').update({
      status: 'complete', final_url: publicUrl, replicate_prediction_id: null,
    }).eq('id', job.id);
    for (const clipUrl of (clipUrls || [])) {
      try {
        const p = decodeURIComponent(clipUrl.split('/axel-videos/')[1]);
        if (p) await supabase.storage.from('axel-videos').remove([p]);
      } catch(e) {}
    }
    log('COMPLETE:', publicUrl);
  } catch(e) {
    log('Store error:', e.message);
    await supabase.from('axel_jobs').update({
      status: 'failed', error: `Store failed: ${e.message}`,
    }).eq('id', job.id);
  }
}
