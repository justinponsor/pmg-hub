// api/axel-status.js — Polls fal.ai and drives the pipeline forward
// Frontend calls GET /api/axel-status?jobId=xxx every 4s

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { jobId } = req.query;

  // Backward-compat: no jobId = return keys
  if (!jobId) {
    return res.status(200).json({
      status: 'online',
      anonKey: process.env.SUPABASE_ANON_KEY || '',
      replicateToken: process.env.REPLICATE_API_TOKEN || '',
    });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const FAL_KEY = process.env.FAL_KEY;
  const log = (...a) => console.log('[Axel:status]', ...a);

  const { data: job, error } = await supabase
    .from('axel_jobs').select('*').eq('id', jobId).single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  if (job.status === 'complete' || job.status === 'failed') {
    return res.status(200).json(statusResponse(job));
  }

  try {
    const predMeta = safeJson(job.replicate_prediction_id);

    // ── TRIMMING ──
    if (job.status === 'trimming' && predMeta?.type === 'trim_batch') {
      const ids = predMeta.ids;
      const clipUrls = safeJson(job.clip_urls);
      const trimmedUrls = safeJson(job.trimmed_urls) || [];

      for (let i = 0; i < ids.length; i++) {
        if (trimmedUrls[i]) continue;
        const result = await falGetResult('fal-ai/workflow-utilities/trim-video', ids[i], FAL_KEY);
        log(`Trim ${i + 1}: ${result.status}`);

        if (result.status === 'COMPLETED' && result.output?.video?.url) {
          trimmedUrls[i] = result.output.video.url;
          log(`Trim ${i + 1} done: ${trimmedUrls[i]}`);
        } else if (result.status === 'FAILED') {
          log(`Trim ${i + 1} failed, using original`);
          trimmedUrls[i] = clipUrls[i];
        }
      }

      const completedCount = trimmedUrls.filter(Boolean).length;
      await supabase.from('axel_jobs').update({
        trimmed_urls: JSON.stringify(trimmedUrls),
        trim_index: Math.max(0, completedCount - 1),
      }).eq('id', jobId);

      if (completedCount === clipUrls.length) {
        log('All trims done');
        if (trimmedUrls.length === 1) {
          await startMusicOrFinish(supabase, job, trimmedUrls[0], FAL_KEY, log);
        } else {
          const mergeReqId = await startMerge(trimmedUrls, FAL_KEY, log);
          await supabase.from('axel_jobs').update({
            status: 'merging',
            trimmed_urls: JSON.stringify(trimmedUrls),
            replicate_prediction_id: JSON.stringify({ type: 'merge', id: mergeReqId }),
          }).eq('id', jobId);
        }
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

    // ── MERGING ──
    if (job.status === 'merging' && predMeta?.type === 'merge') {
      const result = await falGetResult('fal-ai/ffmpeg-api/merge-videos', predMeta.id, FAL_KEY);
      log(`Merge: ${result.status}`);

      if (result.status === 'COMPLETED') {
        const url = result.output?.video?.url || result.output?.url;
        if (url) {
          log('Merge done:', url);
          await startMusicOrFinish(supabase, job, url, FAL_KEY, log);
        } else {
          log('No URL from merge output:', JSON.stringify(result.output));
          await supabase.from('axel_jobs').update({
            status: 'failed', error: 'No URL from merge',
          }).eq('id', jobId);
        }
      } else if (result.status === 'FAILED') {
        log('Merge failed');
        await supabase.from('axel_jobs').update({
          status: 'failed', error: 'Merge step failed',
        }).eq('id', jobId);
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

    // ── MUSIC (Replicate mmaudio) ──
    if (job.status === 'music' && predMeta?.type === 'music') {
      const predRes = await fetch(`https://api.replicate.com/v1/predictions/${predMeta.id}`, {
        headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      const pred = await predRes.json();
      log(`Music: ${pred.status}`);

      if (pred.status === 'succeeded') {
        const out = pred.output;
        const url = typeof out === 'string' ? out
          : out?.url?.href || out?.url
          || (Array.isArray(out) ? out[0] : null);
        if (url) {
          await storeAndFinish(supabase, job, url, safeJson(job.clip_urls), log);
        } else {
          log('No URL from music, using merged video');
          await storeAndFinish(supabase, job, job.current_video_url, safeJson(job.clip_urls), log);
        }
      } else if (pred.status === 'failed' || pred.status === 'canceled') {
        log('Music failed, completing without music');
        await storeAndFinish(supabase, job, job.current_video_url, safeJson(job.clip_urls), log);
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

  } catch (e) {
    log('Handler error:', e.message);
  }

  return res.status(200).json(statusResponse(job));
};

// ── fal.ai helpers ──

// Check status; if COMPLETED, fetch and return the result in one call
async function falGetResult(modelId, requestId, falKey) {
  const statusResp = await fetch(
    `https://queue.fal.run/${modelId}/requests/${requestId}/status?logs=0`,
    { headers: { 'Authorization': `Key ${falKey}` } }
  );
  if (!statusResp.ok) {
    const txt = await statusResp.text();
    throw new Error(`fal status failed (${statusResp.status}): ${txt}`);
  }
  const statusData = await statusResp.json();

  // fal.ai status endpoint does NOT include output — must fetch result separately
  if (statusData.status === 'COMPLETED') {
    const resultResp = await fetch(
      `https://queue.fal.run/${modelId}/requests/${requestId}`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    );
    if (resultResp.ok) {
      const output = await resultResp.json();
      return { status: 'COMPLETED', output };
    }
  }

  return statusData; // IN_QUEUE | IN_PROGRESS | FAILED
}

async function startMerge(trimmedUrls, falKey, log) {
  log(`Submitting merge of ${trimmedUrls.length} clips...`);
  const resp = await fetch('https://queue.fal.run/fal-ai/ffmpeg-api/merge-videos', {
    method: 'POST',
    headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { video_urls: trimmedUrls } }),
  });
  if (!resp.ok) throw new Error(`Merge submit failed: ${await resp.text()}`);
  const data = await resp.json();
  log('Merge queued:', data.request_id);
  return data.request_id;
}

async function startMusicOrFinish(supabase, job, videoUrl, falKey, log) {
  await supabase.from('axel_jobs').update({ current_video_url: videoUrl }).eq('id', job.id);

  if (job.music_source !== 'ai') {
    await storeAndFinish(supabase, job, videoUrl, safeJson(job.clip_urls), log);
    return;
  }

  log('Starting mmaudio...');
  const style = safeJson(job.style) || {};
  const musicVibe = style.musicvibe || 'high energy';

  const predRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'zsxkib/mmaudio',
      input: {
        video: videoUrl,
        prompt: `${musicVibe} background music. ${job.brief}`,
        negative_prompt: 'speech, talking, vocals',
        seed: -1, num_steps: 25,
        duration: job.target_length, cfg_strength: 4.5,
      },
    }),
  });
  const pred = await predRes.json();

  if (pred.id) {
    log('mmaudio started:', pred.id);
    await supabase.from('axel_jobs').update({
      status: 'music',
      replicate_prediction_id: JSON.stringify({ type: 'music', id: pred.id }),
    }).eq('id', job.id);
  } else {
    log('mmaudio failed to start, completing without music');
    await storeAndFinish(supabase, job, videoUrl, safeJson(job.clip_urls), log);
  }
}

async function storeAndFinish(supabase, job, videoUrl, clipUrls, log) {
  log('Storing final video...');
  await supabase.from('axel_jobs').update({ status: 'storing' }).eq('id', job.id);

  try {
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    const fileName = `exports/axel_${Date.now()}.mp4`;
    await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
    const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);

    for (const clipUrl of (clipUrls || [])) {
      try {
        const p = decodeURIComponent(clipUrl.split('/axel-videos/')[1]);
        if (p) await supabase.storage.from('axel-videos').remove([p]);
      } catch(e) {}
    }

    await supabase.from('axel_exports').insert({
      brief: job.brief, format: job.format, duration: job.target_length,
      style: job.style, clip_count: (clipUrls || []).length,
      video_url: publicUrl, created_at: new Date().toISOString(),
    }).catch(() => {});

    await supabase.from('axel_jobs').update({
      status: 'complete', final_url: publicUrl, replicate_prediction_id: null,
    }).eq('id', job.id);
    log('COMPLETE:', publicUrl);

  } catch(e) {
    log('Store error, using source URL:', e.message);
    await supabase.from('axel_jobs').update({
      status: 'complete', final_url: videoUrl, replicate_prediction_id: null,
    }).eq('id', job.id);
  }
}

function safeJson(str) {
  try { return JSON.parse(str); } catch(e) { return null; }
}

function statusResponse(job) {
  if (!job) return { status: 'unknown' };
  const clipCount = (safeJson(job.clip_urls) || []).length;
  const trimmedCount = (safeJson(job.trimmed_urls) || []).filter(Boolean).length;
  let message = '';
  switch (job.status) {
    case 'starting':  message = 'Starting up...'; break;
    case 'trimming':  message = `Trimming clips (${trimmedCount} of ${clipCount} done)...`; break;
    case 'merging':   message = 'Merging clips...'; break;
    case 'music':     message = 'Adding AI music...'; break;
    case 'storing':   message = 'Saving final video...'; break;
    case 'complete':  message = 'Done!'; break;
    case 'failed':    message = `Failed: ${job.error || 'unknown error'}`; break;
    default:          message = job.status;
  }
  return {
    jobId: job.id, status: job.status, message,
    finalUrl: job.final_url || null,
    error: job.error || null, clipCount,
  };
}
