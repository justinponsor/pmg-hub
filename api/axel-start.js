// api/axel-start.js — Axel pipeline using fal.ai for trim/merge/music
// Fast, no timeouts, no ffmpeg binary needed on Vercel
// fal.ai handles: trim, merge, AI music (mmaudio)

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 60;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const FAL_KEY = process.env.FAL_KEY;
  const log = (...a) => console.log('[Axel:start]', ...a);

  if (!FAL_KEY) return res.status(503).json({ error: 'FAL_KEY not configured' });

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

    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));

    // ── STEP 1: Submit trim jobs for all clips in parallel ──
    log(`Submitting ${clipUrls.length} trim jobs to fal.ai...`);
    const trimRequestIds = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const resp = await falQueue('fal-ai/workflow-utilities/trim-video', {
        video_url: clipUrls[i],
        start_time: 0,
        end_time: trimDuration,
      }, FAL_KEY);
      trimRequestIds.push(resp.request_id);
      log(`Trim ${i + 1} queued: ${resp.request_id}`);
    }

    // ── Create job record immediately ──
    const { data: job, error: insertError } = await supabase
      .from('axel_jobs')
      .insert({
        status: 'trimming',
        brief, format,
        target_length: targetLength,
        music_source: musicSource,
        style: JSON.stringify(style),
        clip_urls: JSON.stringify(clipUrls),
        trim_duration: trimDuration,
        trimmed_urls: JSON.stringify([]),
        trim_index: 0,
        merge_index: 1,
        // Store fal request IDs as JSON in replicate_prediction_id field (reusing column)
        replicate_prediction_id: JSON.stringify({ type: 'trim_batch', ids: trimRequestIds }),
        created_at: new Date().toISOString(),
      })
      .select().single();

    if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`);
    log(`Job created: ${job.id}`);

    return res.status(200).json({ jobId: job.id, status: 'trimming' });

  } catch (err) {
    console.error('[Axel:start] FATAL:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function falQueue(modelId, input, falKey) {
  const resp = await fetch(`https://queue.fal.run/${modelId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`fal.ai queue failed for ${modelId}: ${err}`);
  }
  return resp.json();
}
