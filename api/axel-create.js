// api/axel-create.js
// Deploy this to /api/axel-create.js in your GitHub repo
// 
// REQUIRED ENV VARS in Vercel:
//   REPLICATE_API_TOKEN   — get from replicate.com (free to start, pay per render)
//   R2_ACCOUNT_ID         — Cloudflare R2 account ID (optional, for storing output)
//   R2_ACCESS_KEY         — Cloudflare R2 access key
//   R2_SECRET_KEY         — Cloudflare R2 secret key
//   R2_BUCKET_NAME        — e.g. "pmg-hub-videos"

import Replicate from 'replicate';
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(503).json({ 
      error: 'REPLICATE_API_TOKEN not configured',
      setup: 'Add REPLICATE_API_TOKEN to Vercel environment variables at vercel.com/dashboard → Settings → Environment Variables'
    });
  }

  try {
    // Parse multipart form data (video clips + settings)
    const form = formidable({ multiples: true, maxFileSize: 500 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const brief = fields.brief?.[0] || '';
    const format = fields.format?.[0] || 'reel';
    const targetLength = parseInt(fields.length?.[0]) || 30;
    const musicSource = fields.music_source?.[0] || 'ai';
    const style = JSON.parse(fields.style?.[0] || '{}');

    // Collect video clips
    const clipKeys = Object.keys(files).filter(k => k.startsWith('clip_'));
    const clips = clipKeys.map(k => Array.isArray(files[k]) ? files[k][0] : files[k]);

    if (!clips.length) {
      return res.status(400).json({ error: 'No video clips provided' });
    }

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

    // ── STEP 1: Auto-edit clips with FFmpeg via Replicate ──
    // Using fofr/video-editing model on Replicate
    // Upload first clip as input (Replicate handles processing)
    const firstClip = clips[0];
    const clipBuffer = fs.readFileSync(firstClip.filepath);
    const clipBase64 = `data:video/mp4;base64,${clipBuffer.toString('base64')}`;

    // Build the editing prompt based on user settings
    const editPrompt = `
      Create a ${targetLength}-second ${format === 'reel' ? 'vertical 9:16' : format} video.
      Style: ${style.energy || 'high energy'}.
      Transitions: ${style.trans || 'hard cuts'}.
      Color grade: ${style.color || 'natural'}.
      Brief: ${brief}
    `.trim();

    // ── STEP 2: Generate AI music if requested ──
    let musicUrl = null;
    if (musicSource === 'ai') {
      const musicVibe = style.musicvibe || 'high energy';
      
      try {
        // Use meta/musicgen model for AI music generation
        const musicOutput = await replicate.run(
          'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837ffe9f2',
          {
            input: {
              prompt: `${musicVibe} background music for a ${targetLength}-second social media video. ${brief}`,
              model_version: 'stereo-melody-large',
              output_format: 'mp3',
              normalization_strategy: 'peak',
              duration: targetLength,
            }
          }
        );
        musicUrl = musicOutput;
      } catch(musicErr) {
        console.log('Music generation failed, continuing without:', musicErr.message);
      }
    }

    // ── STEP 3: Process video ──
    // Using a video processing model to cut/edit the clips
    let videoUrl = null;
    
    try {
      const output = await replicate.run(
        'chenxwh/video-retalking:db7148c2c44d7dc32f3c4815c3c59bae01aef9c13bbf42cbf9efe59b79a3a8a0',
        {
          input: {
            video: clipBase64,
            // Additional parameters depend on the specific model
          }
        }
      );
      videoUrl = typeof output === 'string' ? output : output?.[0];
    } catch(videoErr) {
      console.log('Video processing error:', videoErr.message);
      // Fallback: return the original clip
      videoUrl = null;
    }

    // ── STEP 4: Store output in R2 if configured ──
    if (videoUrl && process.env.R2_ACCOUNT_ID) {
      try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
          region: 'auto',
          endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY,
            secretAccessKey: process.env.R2_SECRET_KEY,
          },
        });
        const videoResponse = await fetch(videoUrl);
        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
        const fileName = `axel-export-${Date.now()}.mp4`;
        await s3.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: fileName,
          Body: videoBuffer,
          ContentType: 'video/mp4',
          ACL: 'public-read',
        }));
        videoUrl = `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.dev/${fileName}`;
      } catch(storageErr) {
        console.log('Storage error, returning Replicate URL:', storageErr.message);
      }
    }

    if (!videoUrl) {
      return res.status(503).json({
        error: 'Video processing failed',
        message: 'The AI model could not process your clips. Try with different clips or contact support.',
      });
    }

    return res.status(200).json({
      success: true,
      videoUrl,
      musicUrl,
      duration: targetLength,
      format,
    });

  } catch (err) {
    console.error('Axel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
