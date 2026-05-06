// api/axel-create.js
// Axel AI Video Editor — Vercel serverless function
// Uses Replicate for AI processing + Supabase for storage

import Replicate from 'replicate';
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(503).json({ error: 'REPLICATE_API_TOKEN not configured' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const form = formidable({ multiples: true, maxFileSize: 500 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const brief = fields.brief?.[0] || '';
    const format = fields.format?.[0] || 'reel';
    const targetLength = parseInt(fields.length?.[0]) || 30;
    const musicSource = fields.music_source?.[0] || 'ai';
    const style = JSON.parse(fields.style?.[0] || '{}');

    const clips = Object.keys(files).filter(k => k.startsWith('clip_'))
      .map(k => Array.isArray(files[k]) ? files[k][0] : files[k]);

    if (!clips.length) return res.status(400).json({ error: 'No clips provided' });

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Upload clips to Supabase ──
    const clipUrls = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const buffer = fs.readFileSync(clip.filepath);
      const fileName = `clips/${Date.now()}_${i}_${clip.originalFilename || 'clip.mp4'}`;
      const { error } = await supabase.storage.from('axel-videos').upload(fileName, buffer, {
        contentType: clip.mimetype || 'video/mp4',
      });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(fileName);
      clipUrls.push(publicUrl);
    }

    // ── Generate AI music ──
    let musicUrl = null;
    if (musicSource === 'ai') {
      try {
        musicUrl = await replicate.run(
          'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837ffe9f2',
          { input: {
            prompt: `${style.musicvibe || 'high energy'} instrumental background music for a ${targetLength}s social media video. ${brief}`,
            model_version: 'stereo-melody-large',
            output_format: 'mp3',
            duration: targetLength,
          }}
        );
      } catch(e) { console.log('Music gen skipped:', e.message); }
    }

    // ── Color grade + process video ──
    const colorFilters = {
      'Punchy & saturated': 'eq=contrast=1.2:saturation=1.5:brightness=0.02',
      'Moody / desaturated': 'eq=contrast=1.1:saturation=0.6:brightness=-0.05',
      'Warm golden': 'eq=contrast=1.1:saturation=1.2',
      'Cold & crisp': 'eq=contrast=1.15:saturation=0.9',
      'Natural': 'eq=contrast=1.05:saturation=1.1',
    };

    let videoUrl = clipUrls[0]; // fallback to first clip
    try {
      const output = await replicate.run(
        'lucataco/ffmpeg-api:latest',
        { input: {
          video_url: clipUrls[0],
          filter_complex: colorFilters[style.color] || colorFilters['Natural'],
          duration: targetLength,
          ...(musicUrl && { music_url: musicUrl }),
        }}
      );
      videoUrl = typeof output === 'string' ? output : output?.[0] || clipUrls[0];
    } catch(e) { console.log('Video processing error:', e.message); }

    // ── Store output in Supabase ──
    try {
      const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
      const outName = `exports/axel_${Date.now()}.mp4`;
      await supabase.storage.from('axel-videos').upload(outName, buf, { contentType: 'video/mp4' });
      const { data: { publicUrl } } = supabase.storage.from('axel-videos').getPublicUrl(outName);
      videoUrl = publicUrl;
      await supabase.from('axel_exports').insert({
        brief, format, duration: targetLength,
        style: JSON.stringify(style),
        video_url: videoUrl, music_url: musicUrl,
        created_at: new Date().toISOString(),
      });
    } catch(e) { console.log('Storage error:', e.message); }

    return res.status(200).json({ success: true, videoUrl, musicUrl, duration: targetLength, format });

  } catch (err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
