// api/axel-status.js — Polls fal.ai and drives the pipeline forward
// Frontend calls GET /api/axel-status?jobId=xxx every 4s
// This function checks fal.ai job status and advances to the next step when ready

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

  // Terminal states
  if (job.status === 'complete' || job.status === 'failed') {
    return res.status(200).json(statusResponse(job));
  }

  try {
    const predMeta = safeJson(job.replicate_prediction_id);

    // ── TRIMMING: check all trim jobs ──
    if (job.status === 'trimming' && predMeta?.type === 'trim_batch') {
      const ids = predMeta.ids;
      const clipUrls = safeJson(job.clip_urls);
      const trimmedUrls = safeJson(job.trimmed_urls) || [];

      // Check each trim job that isn't done yet
      let allDone = true;
      for (let i = 0; i < ids.length; i++) {
        if (trimmedUrls[i]) continue; // already done
        const status = await falStatus('fal-ai/workflow-utilities/trim-video', ids[i], FAL_KEY);
        log(`Trim ${i + 1} status: ${status.status}`);

        if (status.status === 'COMPLETED') {
          const url = status.output?.video?.url;
          if (url) {
            trimmedUrls[i] = url;
            log(`Trim ${i + 1} done: ${url}`);
          }
        } else if (status.status === 'FAILED') {
          log(`Trim ${i + 1} failed, using original`);
          trimmedUrls[i] = clipUrls[i]; // fallback to original
        } else {
          allDone = false;
        }
      }

      await supabase.from('axel_jobs')
        .update({ trimmed_urls: JSON.stringify(trimmedUrls) })
        .eq('id', jobId);

      const completedCount = trimmedUrls.filter(Boolean).length;
      await supabase.from('axel_jobs')
        .update({ trim_index: completedCount - 1 })
        .eq('id', jobId);

      if (allDone || completedCount === clipUrls.length) {
        log('All trims done, starting merge...');

        if (trimmedUrls.length === 1) {
          // Only 1 clip — skip merge, go to music
          await startMusicOrFinish(supabase, job, trimmedUrls[0], FAL_KEY, log);
        } else {
          // Submit merge job
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

    // ── MERGING: check merge job ──
    if (job.status === 'merging' && predMeta?.type === 'merge') {
      const status = await falStatus('fal-ai/ffmpeg-api/merge-videos', predMeta.id, FAL_KEY);
      log(`Merge status: ${status.status}`);

      if (status.status === 'COMPLETED') {
        const url = status.output?.video?.url || status.output?.url;
        if (url) {
          log('Merge done:', url);
          await startMusicOrFinish(supabase, job, url, FAL_KEY, log);
        } else {
          log('No URL in merge output:', JSON.stringify(status.output));
          await supabase.from('axel_jobs').update({ status: 'failed', error: 'No URL from merge' }).eq('id', jobId);
        }
      } else if (status.status === 'FAILED') {
        log('Merge failed:', JSON.stringify(status.error));
        await supabase.from('axel_jobs').update({ status: 'failed', error: 'Merge failed' }).eq('id', jobId);
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

    // ── MUSIC: check mmaudio job on Replicate ──
    if (job.status === 'music' && predMeta?.type === 'music') {
      const predRes = await fetch(`https://api.replicate.com/v1/predictions/${predMeta.id}`, {
        headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}` }
      });
      const pred = await predRes.json();
      log(`Music status: ${pred.status}`);

      if (pred.status === 'succeeded') {
        const out = pred.output;
        const url = typeof out === 'string' ? out
          : out?.url?.href || out?.url
          || (Array.isArray(out) ? out[0] : null);

        if (url) {
          log('Music done:', url);
          await storeAndFinish(supabase, job, url, safeJson(job.clip_urls), log);
        } else {
          // Music failed to produce URL — use video without music
          log('No URL from music, using video without music');
          await storeAndFinish(supabase, job, job.current_video_url, safeJson(job.clip_urls), log);
        }
      } else if (pred.status === 'failed' || pred.status === 'canceled') {
        log('Music failed, completing without music');
        await storeAndFinish(supabase, job, job.current_video_url, safeJson(job.clip_urls), log);
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

    // ── STORING: check if done ──
    if (job.status === 'storing') {
      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

  } catch (e) {
    log('Error in status handler:', e.message);
  }

  return res.status(200).json(statusResponse(job));
};

// ── Helpers ──

async function startMerge(trimmedUrls, falKey, log) {
  log(`Submitting merge of ${trimmedUrls.length} clips to fal.ai...`);
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

  log('Starting mmaudio on Replicate...');
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
    log('mmaudio failed to start, completing without music:', JSON.stringify(pred));
    await storeAndFinish(supabase, job, videoUrl, safeJson(job.clip_urls), log);
  }
}

async function storeAndFinish(supabase, job, videoUrl, clipUrls, log) {
  log('Storing final video in Supabase...');
  await supabase.from('axel_jobs').update({ status: 'storing' }).eq('id', job.id);

  try {
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    const fileName = `exports/axel_${Date.now()}.mp4`;
    await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
    const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);

    // Clean up raw clips
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

async function falStatus(modelId, requestId, falKey) {
  const resp = await fetch(`https://queue.fal.run/${modelId}/requests/${requestId}/status?logs=0`, {
    headers: { 'Authorization': `Key ${falKey}` },
  });
  if (!resp.ok) throw new Error(`fal status check failed: ${await resp.text()}`);
  return resp.json();
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
