// api/axel-debug.js — Debug endpoint to diagnose fal.ai status
const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 15;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const FAL_KEY = process.env.FAL_KEY;
  const { jobId } = req.query;

  // No jobId = test FAL_KEY directly
  if (!jobId) {
    const testResp = await fetch('https://queue.fal.run/fal-ai/workflow-utilities/trim-video', {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { video_url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', start_time: 0, end_time: 3 } }),
    });
    const testText = await testResp.text();
    return res.status(200).json({
      fal_key_present: !!FAL_KEY,
      fal_key_prefix: FAL_KEY ? FAL_KEY.slice(0, 8) + '...' : 'MISSING',
      test_submit_status: testResp.status,
      test_submit_body: testText,
    });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: job } = await supabase.from('axel_jobs').select('*').eq('id', jobId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const predMeta = safeJson(job.replicate_prediction_id);
  const debug = {
    job_status: job.status,
    pred_meta: predMeta,
    fal_key_present: !!FAL_KEY,
    fal_key_prefix: FAL_KEY ? FAL_KEY.slice(0, 8) + '...' : 'MISSING',
    fal_responses: [],
  };

  if (predMeta?.type === 'trim_batch') {
    for (let i = 0; i < predMeta.ids.length; i++) {
      const id = predMeta.ids[i];
      try {
        const statusResp = await fetch(
          `https://queue.fal.run/fal-ai/workflow-utilities/trim-video/requests/${id}/status`,
          { headers: { 'Authorization': `Key ${FAL_KEY}` } }
        );
        const statusText = await statusResp.text();
        debug.fal_responses.push({
          trim: i + 1,
          request_id: id,
          status_code: statusResp.status,
          status_body: statusText,
        });
      } catch(e) {
        debug.fal_responses.push({ trim: i + 1, request_id: id, error: e.message });
      }
    }
  }

  return res.status(200).json(debug);
};

function safeJson(str) {
  try { return JSON.parse(str); } catch(e) { return null; }
}
