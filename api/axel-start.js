// api/axel-start.js — Submits trim jobs to fal.ai and returns jobId immediately

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 60;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) return res.status(503).json({ error: 'FAL_KEY not configured' });

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

    // Submit all trim jobs in parallel
    const trimRequestIds = [];
    for (let i = 0; i < clipUrls.length; i++) {
      log(`Queueing trim ${i + 1}: ${clipUrls[i]}`);
      const resp = await fetch('https://queue.fal.run/fal-ai/workflow-utilities/trim-video', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${FAL_KEY}`,
          'Content-Type': 'application/json',
        },
        // fal.ai requires params wrapped in "input"
        body: JSON.stringify({
          input: {
            video_url: clipUrls[i],
            start_time: 0,
            end_time: trimDuration,
          }
        }),
      });

      const respText = await resp.text();
      log(`Trim ${i + 1} response (${resp.status}): ${respText}`);

      if (!resp.ok) throw new Error(`fal.ai trim submit failed (${resp.status}): ${respText}`);
      const data = JSON.parse(respText);
      if (!data.request_id) throw new Error(`No request_id in fal response: ${respText}`);
      trimRequestIds.push(data.request_id);
      log(`Trim ${i + 1} queued: ${data.request_id}`);
    }

    // Create job record
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
