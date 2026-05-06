// api/axel-status.js — Polls Replicate and drives the pipeline forward
// Called by frontend every 4s. Checks current prediction, advances pipeline when done.
// No webhooks needed — this is the engine.

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { jobId } = req.query;

  // Backward-compat: no jobId = return keys for getSupabaseAnonKey()
  if (!jobId) {
    return res.status(200).json({
      status: 'online',
      anonKey: process.env.SUPABASE_ANON_KEY || '',
      replicateToken: process.env.REPLICATE_API_TOKEN || '',
    });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const log = (...a) => console.log('[Axel:status]', ...a);

  const { data: job, error } = await supabase
    .from('axel_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  // Terminal states — just return
  if (job.status === 'complete' || job.status === 'failed') {
    return res.status(200).json(statusResponse(job));
  }

  // If there's an active Replicate prediction, check it
  if (job.replicate_prediction_id) {
    try {
      const predRes = await fetch(`https://api.replicate.com/v1/predictions/${job.replicate_prediction_id}`, {
        headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}` }
      });
      const pred = await predRes.json();
      log(`Prediction ${pred.id} status: ${pred.status}`);

      if (pred.status === 'succeeded') {
        const out = pred.output;
        const url = typeof out === 'string' ? out
          : out?.url?.href || out?.url
          || (Array.isArray(out) ? (typeof out[0] === 'string' ? out[0] : out[0]?.url?.href) : null);

        if (url) {
          log(`Step ${job.status} done, url: ${url}`);
          await advancePipeline(supabase, job, url, log);
        } else {
          log('No URL in output:', JSON.stringify(out));
          await supabase.from('axel_jobs').update({ status: 'failed', error: 'No output URL from Replicate' }).eq('id', jobId);
        }

        const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
        return res.status(200).json(statusResponse(updated || job));
      }

      if (pred.status === 'failed' || pred.status === 'canceled') {
        const errMsg = JSON.stringify(pred.error || 'Replicate prediction failed');
        log(`Prediction failed: ${errMsg}`);
        await supabase.from('axel_jobs').update({ status: 'failed', error: errMsg }).eq('id', jobId);
        const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
        return res.status(200).json(statusResponse(updated || job));
      }

      // Still processing — return current status
      return res.status(200).json(statusResponse(job));

    } catch (e) {
      log('Replicate poll error:', e.message);
      return res.status(200).json(statusResponse(job));
    }
  }

  return res.status(200).json(statusResponse(job));
};

async function advancePipeline(supabase, job, outputUrl, log) {
  const jobId = job.id;
  const clipUrls = JSON.parse(job.clip_urls || '[]');
  const trimmedUrls = JSON.parse(job.trimmed_urls || '[]');
  const trimDuration = job.trim_duration;

  if (job.status === 'trimming') {
    const idx = job.trim_index || 0;
    trimmedUrls[idx] = outputUrl;
    const nextIdx = idx + 1;

    if (nextIdx < clipUrls.length) {
      log(`Starting trim ${nextIdx + 1} of ${clipUrls.length}`);
      const pred = await startPrediction({
        version: 'a58ed80215326cba0a80c77a11dd0d0968c567388228891b3c5c67de2a8d10cb',
        input: { video: clipUrls[nextIdx], start_time: "0", end_time: String(trimDuration) }
      });
      await supabase.from('axel_jobs').update({
        trimmed_urls: JSON.stringify(trimmedUrls),
        trim_index: nextIdx,
        replicate_prediction_id: pred.id,
        status: 'trimming',
      }).eq('id', jobId);

    } else {
      log('All clips trimmed');
      await supabase.from('axel_jobs').update({
        trimmed_urls: JSON.stringify(trimmedUrls),
        current_video_url: trimmedUrls[0],
      }).eq('id', jobId);

      if (trimmedUrls.length === 1) {
        await startMusicStep(supabase, job, trimmedUrls[0], log);
      } else {
        log('Starting merge 1');
        const pred = await startPrediction({
          version: '65c81d0d0689d8608af8c2f59728135925419f4b5e62065c37fc350130fed67a',
          input: { video_files: [trimmedUrls[0], trimmedUrls[1]], keep_audio: true }
        });
        await supabase.from('axel_jobs').update({
          status: 'merging',
          merge_index: 1,
          replicate_prediction_id: pred.id,
        }).eq('id', jobId);
      }
    }
  }

  else if (job.status === 'merging') {
    const mergeIdx = job.merge_index || 1;
    const nextMergeIdx = mergeIdx + 1;
    const { data: fresh } = await supabase.from('axel_jobs').select('trimmed_urls').eq('id', jobId).single();
    const freshTrimmed = JSON.parse(fresh?.trimmed_urls || '[]');

    if (nextMergeIdx < clipUrls.length) {
      log(`Merging clip ${nextMergeIdx + 1}`);
      const pred = await startPrediction({
        version: '65c81d0d0689d8608af8c2f59728135925419f4b5e62065c37fc350130fed67a',
        input: { video_files: [outputUrl, freshTrimmed[nextMergeIdx]], keep_audio: true }
      });
      await supabase.from('axel_jobs').update({
        current_video_url: outputUrl,
        merge_index: nextMergeIdx,
        replicate_prediction_id: pred.id,
      }).eq('id', jobId);
    } else {
      log('All merged, starting music');
      await supabase.from('axel_jobs').update({ current_video_url: outputUrl }).eq('id', jobId);
      await startMusicStep(supabase, job, outputUrl, log);
    }
  }

  else if (job.status === 'music') {
    log('Music done, storing');
    await supabase.from('axel_jobs').update({ status: 'storing', current_video_url: outputUrl, replicate_prediction_id: null }).eq('id', jobId);
    await storeAndFinish(supabase, job, outputUrl, clipUrls, log);
  }
}

async function startMusicStep(supabase, job, videoUrl, log) {
  if (job.music_source !== 'ai') {
    await storeAndFinish(supabase, job, videoUrl, JSON.parse(job.clip_urls || '[]'), log);
    return;
  }
  const style = JSON.parse(job.style || '{}');
  const musicVibe = style.musicvibe || 'high energy';
  log('Starting mmaudio');
  const pred = await startPrediction({
    model: 'zsxkib/mmaudio',
    input: {
      video: videoUrl,
      prompt: `${musicVibe} background music. ${job.brief}`,
      negative_prompt: 'speech, talking, vocals',
      seed: -1, num_steps: 25, duration: job.target_length, cfg_strength: 4.5,
    }
  });
  await supabase.from('axel_jobs').update({
    status: 'music',
    replicate_prediction_id: pred.id,
  }).eq('id', job.id);
}

async function storeAndFinish(supabase, job, videoUrl, clipUrls, log) {
  try {
    log('Storing final video');
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    const fileName = `exports/axel_${Date.now()}.mp4`;
    await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
    const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);

    for (const clipUrl of clipUrls) {
      try {
        const path = decodeURIComponent(clipUrl.split('/axel-videos/')[1]);
        if (path) await supabase.storage.from('axel-videos').remove([path]);
      } catch(e) {}
    }

    await supabase.from('axel_exports').insert({
      brief: job.brief, format: job.format, duration: job.target_length,
      style: job.style, clip_count: clipUrls.length,
      video_url: publicUrl, created_at: new Date().toISOString(),
    }).catch(() => {});

    await supabase.from('axel_jobs').update({ status: 'complete', final_url: publicUrl, replicate_prediction_id: null }).eq('id', job.id);
    log('COMPLETE:', publicUrl);
  } catch(e) {
    log('Store error, using Replicate URL:', e.message);
    await supabase.from('axel_jobs').update({ status: 'complete', final_url: videoUrl, replicate_prediction_id: null }).eq('id', job.id);
  }
}

async function startPrediction(body) {
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const pred = await res.json();
  if (!pred.id) throw new Error(`Replicate start failed: ${JSON.stringify(pred)}`);
  return pred;
}

function statusResponse(job) {
  if (!job) return { status: 'unknown' };
  const clipCount = JSON.parse(job.clip_urls || '[]').length;
  let message = '';
  switch (job.status) {
    case 'starting':  message = 'Starting up...'; break;
    case 'trimming':  message = `Trimming clip ${(job.trim_index || 0) + 1} of ${clipCount}...`; break;
    case 'merging':   message = `Merging clips (${(job.merge_index || 1)} of ${clipCount - 1})...`; break;
    case 'music':     message = 'Adding AI music...'; break;
    case 'storing':   message = 'Saving final video...'; break;
    case 'complete':  message = 'Done!'; break;
    case 'failed':    message = `Failed: ${job.error || 'unknown error'}`; break;
    default:          message = job.status;
  }
  return {
    jobId: job.id, status: job.status, message,
    finalUrl: job.final_url || null, error: job.error || null, clipCount,
  };
}
