// api/axel-start.js — Starts an Axel job and returns immediately with a jobId
// The actual processing happens via webhooks in axel-webhook.js

const { createClient } = require('@supabase/supabase-js');

module.exports.maxDuration = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const log = (...args) => console.log('[Axel:start]', ...args);

  try {
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');
    const format = body.format || 'reel';

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });

    // Build the webhook URL — Replicate will POST here after each step
    const webhookBase = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://pmg-hub.vercel.app';
    const webhookUrl = `${webhookBase}/api/axel-webhook`;

    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));

    // Create job record in Supabase
    const { data: job, error: insertError } = await supabase
      .from('axel_jobs')
      .insert({
        status: 'starting',
        brief,
        format,
        target_length: targetLength,
        music_source: musicSource,
        style: JSON.stringify(style),
        clip_urls: JSON.stringify(clipUrls),
        trim_duration: trimDuration,
        trimmed_urls: JSON.stringify([]),
        trim_index: 0,          // which clip we're currently trimming
        merge_index: 1,         // which clip index we're merging next
        current_video_url: null,
        final_url: null,
        error: null,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`);

    log(`Job created: ${job.id}`);

    // Fire the first trim prediction
    const firstClipUrl = clipUrls[0];
    log(`Starting trim of clip 1: ${firstClipUrl}`);

    const predResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Prefer': 'respond-async',
      },
      body: JSON.stringify({
        version: 'a58ed80215326cba0a80c77a11dd0d0968c567388228891b3c5c67de2a8d10cb',
        input: {
          video: firstClipUrl,
          start_time: "0",
          end_time: String(trimDuration),
        },
        webhook: `${webhookUrl}?jobId=${job.id}&step=trim&index=0`,
        webhook_events_filter: ['completed'],
      }),
    });

    if (!predResponse.ok) {
      const err = await predResponse.text();
      throw new Error(`Replicate prediction failed: ${err}`);
    }

    const pred = await predResponse.json();
    log(`Prediction started: ${pred.id}`);

    // Update job with prediction ID
    await supabase
      .from('axel_jobs')
      .update({ status: 'trimming', replicate_prediction_id: pred.id })
      .eq('id', job.id);

    return res.status(200).json({ jobId: job.id, status: 'started' });

  } catch (err) {
    console.error('[Axel:start] FATAL:', err);
    return res.status(500).json({ error: err.message });
  }
};
