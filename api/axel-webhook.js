// api/axel-webhook.js — Replicate calls this after each step completes
// Drives the pipeline: trim(0) → trim(1) → ... → merge → music → store → done

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 60;

module.exports = async function handler(req, res) {
  // Replicate sends POST, always respond 200 fast so it doesn't retry
  res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const log = (...args) => console.log('[Axel:webhook]', ...args);

  try {
    const { jobId, step, index } = req.query;
    const prediction = req.body;

    if (!jobId) { log('No jobId in query'); return; }
    log(`jobId=${jobId} step=${step} index=${index} status=${prediction?.status}`);

    // Only process completed predictions
    if (prediction?.status !== 'succeeded') {
      const errMsg = JSON.stringify(prediction?.error || 'unknown');
      log(`Prediction not succeeded: ${prediction?.status} — ${errMsg}`);
      await supabase.from('axel_jobs').update({
        status: 'failed',
        error: `Step ${step}[${index}] failed: ${errMsg}`,
      }).eq('id', jobId);
      return;
    }

    // Extract URL from Replicate output
    const out = prediction.output;
    const url = typeof out === 'string' ? out
      : out?.url?.href || out?.url
      || (Array.isArray(out) ? (typeof out[0] === 'string' ? out[0] : out[0]?.url?.href) : null);

    if (!url) {
      log(`No URL in output for step=${step} index=${index}:`, JSON.stringify(out));
      await supabase.from('axel_jobs').update({
        status: 'failed',
        error: `No output URL for step ${step}[${index}]`,
      }).eq('id', jobId);
      return;
    }

    log(`Got URL for step=${step}[${index}]: ${url}`);

    // Fetch current job state
    const { data: job, error: fetchError } = await supabase
      .from('axel_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) { log('Job not found:', jobId); return; }

    const clipUrls = JSON.parse(job.clip_urls);
    const trimmedUrls = JSON.parse(job.trimmed_urls || '[]');
    const webhookBase = 'https://pmg-hub.vercel.app';
    const webhookUrl = `${webhookBase}/api/axel-webhook`;

    // ── TRIM STEP ──
    if (step === 'trim') {
      const idx = parseInt(index);
      trimmedUrls[idx] = url;
      log(`Trim ${idx} saved. Have ${trimmedUrls.filter(Boolean).length}/${clipUrls.length}`);

      const nextTrimIdx = idx + 1;

      if (nextTrimIdx < clipUrls.length) {
        // Trim the next clip
        log(`Trimming clip ${nextTrimIdx + 1}: ${clipUrls[nextTrimIdx]}`);
        await supabase.from('axel_jobs').update({
          trimmed_urls: JSON.stringify(trimmedUrls),
          trim_index: nextTrimIdx,
          status: 'trimming',
        }).eq('id', jobId);

        const predResponse = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            version: 'a58ed80215326cba0a80c77a11dd0d0968c567388228891b3c5c67de2a8d10cb',
            input: {
              video: clipUrls[nextTrimIdx],
              start_time: "0",
              end_time: String(job.trim_duration),
            },
            webhook: `${webhookUrl}?jobId=${jobId}&step=trim&index=${nextTrimIdx}`,
            webhook_events_filter: ['completed'],
          }),
        });
        const pred = await predResponse.json();
        log(`Next trim prediction: ${pred.id}`);

      } else {
        // All clips trimmed — start merging
        log('All clips trimmed. Starting merge...');
        await supabase.from('axel_jobs').update({
          trimmed_urls: JSON.stringify(trimmedUrls),
          status: 'merging',
          current_video_url: trimmedUrls[0],
          merge_index: 1,
        }).eq('id', jobId);

        if (trimmedUrls.length === 1) {
          // Only one clip, skip merge — go straight to music
          await triggerMusic(supabase, job, trimmedUrls[0], webhookUrl, log);
        } else {
          // Merge clip[0] + clip[1]
          const predResponse = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              version: '65c81d0d0689d8608af8c2f59728135925419f4b5e62065c37fc350130fed67a',
              input: {
                video_files: [trimmedUrls[0], trimmedUrls[1]],
                keep_audio: true,
              },
              webhook: `${webhookUrl}?jobId=${jobId}&step=merge&index=1`,
              webhook_events_filter: ['completed'],
            }),
          });
          const pred = await predResponse.json();
          log(`Merge prediction: ${pred.id}`);
        }
      }
    }

    // ── MERGE STEP ──
    else if (step === 'merge') {
      const mergeIdx = parseInt(index);
      const nextMergeIdx = mergeIdx + 1;

      log(`Merge ${mergeIdx} done. Result: ${url}`);
      await supabase.from('axel_jobs').update({
        current_video_url: url,
        merge_index: nextMergeIdx,
      }).eq('id', jobId);

      if (nextMergeIdx < clipUrls.length) {
        // More clips to merge
        const nextClipUrl = trimmedUrls[nextMergeIdx];
        log(`Merging next clip ${nextMergeIdx + 1}: ${nextClipUrl}`);

        const predResponse = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            version: '65c81d0d0689d8608af8c2f59728135925419f4b5e62065c37fc350130fed67a',
            input: {
              video_files: [url, nextClipUrl],
              keep_audio: true,
            },
            webhook: `${webhookUrl}?jobId=${jobId}&step=merge&index=${nextMergeIdx}`,
            webhook_events_filter: ['completed'],
          }),
        });
        const pred = await predResponse.json();
        log(`Next merge prediction: ${pred.id}`);

      } else {
        // All merged — go to music
        log('All clips merged. Moving to music...');
        await triggerMusic(supabase, job, url, webhookUrl, log);
      }
    }

    // ── MUSIC STEP ──
    else if (step === 'music') {
      log(`Music done: ${url}`);
      await supabase.from('axel_jobs').update({
        status: 'storing',
        current_video_url: url,
      }).eq('id', jobId);

      await storeAndFinish(supabase, job, url, clipUrls, log);
    }

  } catch (err) {
    console.error('[Axel:webhook] FATAL:', err);
    try {
      const { jobId } = req.query;
      if (jobId) {
        const supabase2 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        await supabase2.from('axel_jobs').update({
          status: 'failed',
          error: err.message,
        }).eq('id', jobId);
      }
    } catch(e) {}
  }
};

// ── Helpers ──

async function triggerMusic(supabase, job, videoUrl, webhookUrl, log) {
  if (job.music_source !== 'ai') {
    // No music requested — go straight to store
    await storeAndFinish(supabase, job, videoUrl, JSON.parse(job.clip_urls), log);
    return;
  }

  const style = JSON.parse(job.style || '{}');
  const musicVibe = style.musicvibe || 'high energy';

  log('Triggering mmaudio...');
  await supabase.from('axel_jobs').update({ status: 'music' }).eq('id', job.id);

  const predResponse = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'zsxkib/mmaudio',
      input: {
        video: videoUrl,
        prompt: `${musicVibe} background music for a ski/snowboard video. ${job.brief}`,
        negative_prompt: 'speech, talking, vocals, voice',
        seed: -1,
        num_steps: 25,
        duration: job.target_length,
        cfg_strength: 4.5,
      },
      webhook: `${webhookUrl}?jobId=${job.id}&step=music&index=0`,
      webhook_events_filter: ['completed'],
    }),
  });
  const pred = await predResponse.json();
  log(`mmaudio prediction: ${pred.id}`);
}

async function storeAndFinish(supabase, job, videoUrl, clipUrls, log) {
  log('Storing final video in Supabase...');

  try {
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    const fileName = `exports/axel_${Date.now()}.mp4`;
    await supabase.storage.from('axel-videos').upload(fileName, buf, { contentType: 'video/mp4' });
    const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);

    // Clean up raw clips
    for (const clipUrl of clipUrls) {
      try {
        const path = decodeURIComponent(clipUrl.split('/axel-videos/')[1]);
        if (path) await supabase.storage.from('axel-videos').remove([path]);
      } catch(e) {}
    }

    // Log to axel_exports
    await supabase.from('axel_exports').insert({
      brief: job.brief,
      format: job.format,
      duration: job.target_length,
      style: job.style,
      clip_count: clipUrls.length,
      video_url: publicUrl,
      created_at: new Date().toISOString(),
    }).catch(() => {});

    // Mark job complete
    await supabase.from('axel_jobs').update({
      status: 'complete',
      final_url: publicUrl,
    }).eq('id', job.id);

    log(`COMPLETE: ${publicUrl}`);

  } catch(e) {
    log('Store error:', e.message);
    await supabase.from('axel_jobs').update({
      status: 'complete',
      final_url: videoUrl, // use Replicate URL as fallback
    }).eq('id', job.id);
  }
}
