// api/axel-start.js — Fast video processing using local ffmpeg
// Trim + merge happens in Vercel /tmp (seconds, not minutes)
// Only Replicate call is for AI music (GPU needed)

const { createClient } = require('@supabase/supabase-js');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports.maxDuration = 300;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const log = (...a) => console.log('[Axel:start]', ...a);
  const tmpFiles = [];

  try {
    const body = req.body || {};
    const clipUrls = JSON.parse(body.clip_urls || '[]');
    const brief = body.brief || '';
    const targetLength = parseInt(body.length) || 30;
    const musicSource = body.music_source || 'ai';
    const style = JSON.parse(body.style || '{}');
    const format = body.format || 'reel';

    if (!clipUrls.length) return res.status(400).json({ error: 'No clip URLs provided' });
    log(`Starting: ${clipUrls.length} clips, ${targetLength}s`);

    const trimDuration = Math.max(3, Math.floor(targetLength / clipUrls.length));
    const tmpDir = '/tmp';

    // ── STEP 1: Download all clips ──
    log('Downloading clips...');
    const localPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      log(`Downloading clip ${i + 1}...`);
      const resp = await fetch(clipUrls[i]);
      if (!resp.ok) throw new Error(`Failed to download clip ${i + 1}: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const isMovFile = clipUrls[i].toLowerCase().includes('.mov');
      const localPath = path.join(tmpDir, `clip_${Date.now()}_${i}.${isMovFile ? 'mov' : 'mp4'}`);
      fs.writeFileSync(localPath, buf);
      localPaths.push(localPath);
      tmpFiles.push(localPath);
      log(`Clip ${i + 1} saved: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
    }

    // ── STEP 2: Trim each clip ──
    log('Trimming clips...');
    const trimmedPaths = [];
    for (let i = 0; i < localPaths.length; i++) {
      const trimmedPath = path.join(tmpDir, `trimmed_${Date.now()}_${i}.mp4`);
      tmpFiles.push(trimmedPath);
      await new Promise((resolve, reject) => {
        ffmpeg(localPaths[i])
          .setStartTime(0)
          .setDuration(trimDuration)
          .outputOptions([
            '-c:v libx264', '-preset ultrafast', '-crf 23',
            '-c:a aac', '-movflags +faststart',
          ])
          .output(trimmedPath)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`Trim ${i + 1} failed: ${err.message}`)))
          .run();
      });
      trimmedPaths.push(trimmedPath);
      log(`Clip ${i + 1} trimmed to ${trimDuration}s`);
    }

    // ── STEP 3: Merge all trimmed clips ──
    let mergedPath = trimmedPaths[0];
    if (trimmedPaths.length > 1) {
      log('Merging clips...');
      mergedPath = path.join(tmpDir, `merged_${Date.now()}.mp4`);
      tmpFiles.push(mergedPath);
      const concatListPath = path.join(tmpDir, `concat_${Date.now()}.txt`);
      tmpFiles.push(concatListPath);
      fs.writeFileSync(concatListPath, trimmedPaths.map(p => `file '${p}'`).join('\n'));

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions([
            '-c:v libx264', '-preset ultrafast', '-crf 23',
            '-c:a aac', '-movflags +faststart',
          ])
          .output(mergedPath)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`Merge failed: ${err.message}`)))
          .run();
      });
      log('Clips merged');
    }

    // ── STEP 4: Upload merged video to Supabase ──
    log('Uploading merged video...');
    const mergedBuf = fs.readFileSync(mergedPath);
    const mergedFileName = `processing/merged_${Date.now()}.mp4`;
    const { error: uploadErr } = await supabase.storage
      .from('axel-videos')
      .upload(mergedFileName, mergedBuf, { contentType: 'video/mp4' });
    if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`);
    const { data: { publicUrl: mergedUrl } } = supabase.storage.from('axel-videos').getPublicUrl(mergedFileName);
    log('Merged video uploaded:', mergedUrl);

    // ── STEP 5: Create job record ──
    const { data: job, error: insertError } = await supabase
      .from('axel_jobs')
      .insert({
        status: musicSource === 'ai' ? 'music' : 'complete',
        brief, format,
        target_length: targetLength,
        music_source: musicSource,
        style: JSON.stringify(style),
        clip_urls: JSON.stringify(clipUrls),
        trim_duration: trimDuration,
        current_video_url: mergedUrl,
        final_url: musicSource !== 'ai' ? mergedUrl : null,
        created_at: new Date().toISOString(),
      })
      .select().single();

    if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`);

    // ── STEP 6: Fire Replicate music (if AI music) ──
    if (musicSource === 'ai') {
      log('Starting mmaudio...');
      const musicVibe = JSON.parse(body.style || '{}').musicvibe || 'high energy';
      const predRes = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'zsxkib/mmaudio',
          input: {
            video: mergedUrl,
            prompt: `${musicVibe} background music. ${brief}`,
            negative_prompt: 'speech, talking, vocals',
            seed: -1, num_steps: 25,
            duration: targetLength, cfg_strength: 4.5,
          },
        }),
      });
      const pred = await predRes.json();
      if (pred.id) {
        await supabase.from('axel_jobs').update({ replicate_prediction_id: pred.id }).eq('id', job.id);
        log('mmaudio started:', pred.id);
      } else {
        log('mmaudio failed, falling back to no music:', JSON.stringify(pred));
        await supabase.from('axel_jobs').update({ status: 'complete', final_url: mergedUrl }).eq('id', job.id);
      }
    }

    // Clean up original uploaded clips from Supabase storage
    for (const clipUrl of clipUrls) {
      try {
        const p = decodeURIComponent(clipUrl.split('/axel-videos/')[1]);
        if (p) await supabase.storage.from('axel-videos').remove([p]);
      } catch(e) {}
    }

    return res.status(200).json({ jobId: job.id, status: musicSource === 'ai' ? 'music' : 'complete' });

  } catch (err) {
    console.error('[Axel:start] FATAL:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    for (const f of tmpFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
    }
  }
};
