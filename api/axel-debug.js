// api/axel-debug.js — Temporary debug endpoint
// Call: GET /api/axel-debug?jobId=xxx
// Shows raw job state + raw fal.ai responses so we can see exactly what's happening

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 15;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const FAL_KEY = process.env.FAL_KEY;

  const { data: job } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const predMeta = safeJson(job.replicate_prediction_id);
  const debug = { job_status: job.status, pred_meta: predMeta, fal_responses: [] };

  if (predMeta?.type === 'trim_batch') {
    for (let i = 0; i < predMeta.ids.length; i++) {
      const id = predMeta.ids[i];
      try {
        const statusResp = await fetch(
          `https://queue.fal.run/fal-ai/workflow-utilities/trim-video/requests/${id}/status`,
          { headers: { 'Authorization': `Key ${FAL_KEY}` } }
        );
        const statusText = await statusResp.text();
        debug.fal_responses.push({ trim: i + 1, request_id: id, status_raw: statusText });
      } catch(e) {
        debug.fal_responses.push({ trim: i + 1, request_id: id, error: e.message });
      }
    }
  }

  if (predMeta?.type === 'merge') {
    try {
      const statusResp = await fetch(
        `https://queue.fal.run/fal-ai/ffmpeg-api/merge-videos/requests/${predMeta.id}/status`,
        { headers: { 'Authorization': `Key ${FAL_KEY}` } }
      );
      debug.fal_responses.push({ merge: predMeta.id, status_raw: await statusResp.text() });
    } catch(e) {
      debug.fal_responses.push({ merge: predMeta.id, error: e.message });
    }
  }

  return res.status(200).json(debug);
};

function safeJson(str) {
  try { return JSON.parse(str); } catch(e) { return null; }
}
