// api/axel-status.js — Only needs to poll Replicate mmaudio now
// All trim/merge happens synchronously in axel-start.js

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 15;

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

    // ── MUSIC: poll Replicate mmaudio ──
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
        log('Music failed, storing without music');
        await storeAndFinish(supabase, job, job.current_video_url, safeJson(job.clip_urls), log);
      }

      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

    // ── STORING: just wait ──
    if (job.status === 'storing') {
      const { data: updated } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
      return res.status(200).json(statusResponse(updated || job));
    }

  } catch (e) {
    log('Handler error:', e.message);
    console.error(e);
  }

  return res.status(200).json(statusResponse(job));
};

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
  let message = '';
  switch (job.status) {
    case 'starting':  message = 'Starting up...'; break;
    case 'trimming':  message = 'Trimming and merging clips...'; break;
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
