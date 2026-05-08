// api/axel-status.js — Polls fal.ai using @fal-ai/client (handles auth + URLs correctly)

const { createClient } = require('@supabase/supabase-js');
const { fal } = require('@fal-ai/client');

module.exports.maxDuration = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { jobId } = req.query;

  if (!jobId) {
    return res.status(200).json({
      status: 'online',
      anonKey: process.env.SUPABASE_ANON_KEY || '',
      replicateToken: process.env.REPLICATE_API_TOKEN || '',
    });
  }

  const FAL_KEY = process.env.FAL_KEY;
  fal.config({ credentials: FAL_KEY });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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

        // Use fal client to check status — it handles auth and URL construction
        const status = await fal.queue.status('fal-ai/workflow-utilities/trim-video', {
          requestId: ids[i],
          logs: false,
        });
        log(`Trim ${i + 1} status: ${status.status}`);

        if (status.status === 'COMPLETED') {
          // Use fal client to fetch result
          const result = await fal.queue.result('fal-ai/workflow-utilities/trim-video', {
            requestId: ids[i],
          });
          log(`Trim ${i + 1} result:`, JSON.stringify(result).slice(0, 300));
          const url = result?.data?.video?.url || result?.video?.url || result?.url
            || (result?.data ? Object.values(result.data).find(v => typeof v === 'string' && v.startsWith('http')) : null);
          if (url) {
            trimmedUrls[i] = url;
            log(`Trim ${i + 1} done: ${url}`);
          } else {
            log(`Trim ${i + 1} no URL, using original. Full result:`, JSON.stringify(result));
            trimmedUrls[i] = clipUrls[i];
          }
        } else if (status.status === 'FAILED') {
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
        log('All trims complete!');
        if (trimmedUrls.length === 1) {
          await startMusicOrFinish(supabase, job, trimmedUrls[0], log);
        } else {
          const mergeRequestId = await submitMerge(trimmedUrls, log);
          await supabase.from('axel_jobs').update({
            status: 'merging',
            trimmed_urls: JSON.stringify(trimmedUrls),
            replicate_prediction_id: JSON.stringify({ type: 'merge', id: mergeRequestId }),
          }).eq('id', jobId);
        }
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

    // ── MERGING ──
    if (job.status === 'merging' && predMeta?.type === 'merge') {
      const status = await fal.queue.status('fal-ai/ffmpeg-api/merge-videos', {
        requestId: predMeta.id,
        logs: false,
      });
      log(`Merge status: ${status.status}`);

      if (status.status === 'COMPLETED') {
        const result = await fal.queue.result('fal-ai/ffmpeg-api/merge-videos', {
          requestId: predMeta.id,
        });
        log(`Merge result:`, JSON.stringify(result).slice(0, 300));
        const url = result?.data?.video?.url || result?.video?.url || result?.url
          || (result?.data ? Object.values(result.data).find(v => typeof v === 'string' && v.startsWith('http')) : null);
        if (url) {
          log('Merge done:', url);
          await startMusicOrFinish(supabase, job, url, log);
        } else {
          log('Merge no URL, using first trimmed clip. Full result:', JSON.stringify(result));
          const trimmedUrls = safeJson(job.trimmed_urls) || [];
          await startMusicOrFinish(supabase, job, trimmedUrls[0] || job.current_video_url, log);
        }
      } else if (status.status === 'FAILED') {
        log('Merge failed');
        await supabase.from('axel_jobs').update({ status: 'failed', error: 'Merge failed' }).eq('id', jobId);
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
        await storeAndFinish(supabase, job, url || job.current_video_url, safeJson(job.clip_urls), log);
      } else if (pred.status === 'failed' || pred.status === 'canceled') {
        log('Music failed, completing without music');
        await storeAndFinish(supabase, job, job.current_video_url, safeJson(job.clip_urls), log);
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

  } catch (e) {
    log('Handler error:', e.message);
    console.error(e);
  }

  return res.status(200).json(statusResponse(job));
};

async function submitMerge(trimmedUrls, log) {
  log(`Submitting merge of ${trimmedUrls.length} clips via fal client...`);
  const { request_id } = await fal.queue.submit('fal-ai/ffmpeg-api/merge-videos', {
    input: { video_urls: trimmedUrls },
  });
  log(`Merge queued: ${request_id}`);
  return request_id;
}

async function startMusicOrFinish(supabase, job, videoUrl, log) {
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
    log('mmaudio failed to start:', JSON.stringify(pred));
    await storeAndFinish(supabase, job, videoUrl, safeJson(job.clip_urls), log);
  }
}

async function storeAndFinish(supabase, job, videoUrl, clipUrls, log) {
  log('Storing final video from:', videoUrl);
  await supabase.from('axel_jobs').update({ status: 'storing' }).eq('id', job.id);

  try {
    const fetchResp = await fetch(videoUrl);
    if (!fetchResp.ok) throw new Error(`Fetch failed (${fetchResp.status}): ${videoUrl}`);
    const buf = Buffer.from(await fetchResp.arrayBuffer());
    log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)}MB`);

    const fileName = `exports/axel_${Date.now()}.mp4`;
    const { error: uploadErr } = await supabase.storage
      .from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

    const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);

    await supabase.from('axel_jobs').update({
      status: 'complete', final_url: publicUrl, replicate_prediction_id: null,
    }).eq('id', job.id);

    try {
      await supabase.from('axel_exports').insert({
        brief: job.brief, format: job.format, duration: job.target_length,
        style: job.style, clip_count: (clipUrls || []).length,
        video_url: publicUrl, created_at: new Date().toISOString(),
      });
    } catch(e) { log('axel_exports insert non-fatal:', e.message); }

    // Clean up original clips after confirming save
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
      status: 'failed', error: `Store failed: ${e.message}`, replicate_prediction_id: null,
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
