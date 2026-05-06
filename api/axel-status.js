// api/axel-status.js — Returns current job status for polling
// Frontend calls GET /api/axel-status?jobId=xxx every 3-5 seconds

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 10;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: job, error } = await supabase
    .from('axel_jobs')
    .select('id, status, final_url, error, trim_index, merge_index, clip_urls, created_at')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  const clipCount = JSON.parse(job.clip_urls || '[]').length;

  // Generate a human-readable progress message
  let message = '';
  switch (job.status) {
    case 'starting':   message = 'Starting up...'; break;
    case 'trimming':   message = `Trimming clip ${(job.trim_index || 0) + 1} of ${clipCount}...`; break;
    case 'merging':    message = `Merging clips (${job.merge_index || 1} of ${clipCount - 1})...`; break;
    case 'music':      message = 'Adding AI music...'; break;
    case 'storing':    message = 'Saving final video...'; break;
    case 'complete':   message = 'Done!'; break;
    case 'failed':     message = `Failed: ${job.error || 'unknown error'}`; break;
    default:           message = job.status;
  }

  return res.status(200).json({
    jobId: job.id,
    status: job.status,
    message,
    finalUrl: job.final_url || null,
    error: job.error || null,
    clipCount,
  });
};
