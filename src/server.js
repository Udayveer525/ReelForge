const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Helpers ────────────────────────────────────────────────────────────────

// Download a remote URL to a local file path
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      // Follow redirects (Pexels CDN does this)
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Run an ffmpeg command, returns stdout+stderr on success
function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`FFmpeg error: ${stderr}`));
      resolve({ stdout, stderr });
    });
  });
}

// Wrap text into lines of ~maxChars for the subtitle overlay
function wrapText(text, maxChars = 32) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines.join('\n');
}

// Clean up temp files (fire-and-forget)
function cleanup(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
}

// ─── Ping (keeps Render free tier awake) ────────────────────────────────────
app.get('/ping', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.send('🎬 ReelForge is alive'));

// ─── Main endpoint ───────────────────────────────────────────────────────────
/**
 * POST /render-reel
 * Body:
 * {
 *   "voiceover_url": "https://...",   // ElevenLabs MP3
 *   "background_url": "https://...",  // Pexels MP4
 *   "caption_text":  "...",           // Words shown as subtitle
 *   "webhook_url":   "https://..."    // n8n webhook to receive the final MP4 URL (optional)
 * }
 *
 * Returns:
 * { "status": "ok", "video_url": "https://..." }
 * — OR fires webhook and returns { "status": "processing" } immediately
 */
app.post('/render-reel', async (req, res) => {
  const { voiceover_url, background_url, caption_text, webhook_url } = req.body;

  if (!voiceover_url || !background_url || !caption_text) {
    return res.status(400).json({ error: 'Missing voiceover_url, background_url, or caption_text' });
  }

  // If a webhook URL is given, respond immediately and process in background
  if (webhook_url) {
    res.json({ status: 'processing', message: 'Reel rendering started. Webhook will fire when done.' });
    processReel({ voiceover_url, background_url, caption_text, webhook_url });
  } else {
    // Synchronous mode — wait for the reel and return the URL
    try {
      const result = await processReel({ voiceover_url, background_url, caption_text });
      res.json({ status: 'ok', video_url: result.video_url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── Core rendering logic ─────────────────────────────────────────────────────
async function processReel({ voiceover_url, background_url, caption_text, webhook_url }) {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const bgPath  = path.join(TEMP_DIR, `bg_${id}.mp4`);
  const voPath  = path.join(TEMP_DIR, `vo_${id}.mp3`);
  const subPath = path.join(TEMP_DIR, `sub_${id}.srt`);
  const outPath = path.join(TEMP_DIR, `reel_${id}.mp4`);

  try {
    console.log(`[${id}] Downloading background + voiceover...`);
    await Promise.all([
      downloadFile(background_url, bgPath),
      downloadFile(voiceover_url, voPath),
    ]);

    // ── Get voiceover duration so we know how long the video should be ──
    const durationRaw = await new Promise((resolve, reject) => {
      exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${voPath}"`,
        (err, stdout) => err ? reject(err) : resolve(stdout.trim())
      );
    });
    const audioDuration = parseFloat(durationRaw) || 20;
    // Add 1s pad at end so it doesn't cut abruptly
    const videoDuration = audioDuration + 1;

    // ── Build a simple SRT subtitle from caption_text ─────────────────────
    // We spread words evenly across the voiceover duration for a word-by-word feel
    const words = caption_text.split(/\s+/);
    const secPerWord = audioDuration / words.length;
    let srtContent = '';
    let srtIndex = 1;
    const wordsPerChunk = 4; // how many words per subtitle card
    for (let i = 0; i < words.length; i += wordsPerChunk) {
      const chunk = words.slice(i, i + wordsPerChunk).join(' ');
      const startSec = i * secPerWord;
      const endSec = Math.min((i + wordsPerChunk) * secPerWord, audioDuration);
      const toTimecode = (s) => {
        const h = Math.floor(s / 3600).toString().padStart(2, '0');
        const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
        const sec = Math.floor(s % 60).toString().padStart(2, '0');
        const ms = Math.round((s % 1) * 1000).toString().padStart(3, '0');
        return `${h}:${m}:${sec},${ms}`;
      };
      srtContent += `${srtIndex}\n${toTimecode(startSec)} --> ${toTimecode(endSec)}\n${chunk}\n\n`;
      srtIndex++;
    }
    fs.writeFileSync(subPath, srtContent);

    // ── FFmpeg: loop bg video, overlay subtitles, mix voiceover ──────────
    // Subtitle style: big white bold text with dark shadow — cinematic dark look
    const subtitleStyle = [
      'FontName=Arial',
      'FontSize=28',
      'PrimaryColour=&H00FFFFFF',   // white text
      'OutlineColour=&H00000000',   // black outline
      'BackColour=&H80000000',       // semi-transparent black box
      'Bold=1',
      'Alignment=2',                 // bottom center
      'MarginV=60',
      'BorderStyle=4',               // opaque box
      'Outline=2',
      'Shadow=2',
    ].join(',');

    // We use -stream_loop -1 to loop the background clip to match audio length
    // -vf: scale to 1080x1920 (Reels 9:16), add blur vignette, then burn subtitles
    const ffmpegCmd = [
      `ffmpeg -y`,
      `-stream_loop -1 -i "${bgPath}"`,       // loop background
      `-i "${voPath}"`,                         // voiceover
      `-t ${videoDuration}`,                    // trim to audio length + 1s
      `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,`,
      // Dark vignette overlay to make text more readable
      `vignette=PI/4,`,
      // Burn in subtitles
      `subtitles='${subPath.replace(/\\/g, '/')}':force_style='${subtitleStyle}'"`,
      `-c:v libx264 -preset fast -crf 23`,     // good quality, reasonable size
      `-c:a aac -b:a 192k`,
      `-map 0:v:0 -map 1:a:0`,                 // video from bg, audio from voiceover
      `-movflags +faststart`,                   // web-optimised
      `"${outPath}"`,
    ].join(' ');

    console.log(`[${id}] Running FFmpeg...`);
    await runFFmpeg(ffmpegCmd);
    console.log(`[${id}] FFmpeg done ✅`);

    // ── Upload to Cloudinary ──────────────────────────────────────────────
    const videoUrl = await uploadToCloudinary(outPath, id);
    console.log(`[${id}] Uploaded: ${videoUrl}`);

    cleanup(bgPath, voPath, subPath, outPath);

    if (webhook_url) {
      // Fire the webhook so n8n can pick up the URL and post to Instagram
      const payload = JSON.stringify({ status: 'ok', video_url: videoUrl, render_id: id });
      const u = new URL(webhook_url);
      const reqMod = u.protocol === 'https:' ? https : http;
      const options = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      };
      await new Promise((res, rej) => {
        const r = reqMod.request(options, res);
        r.on('error', rej);
        r.write(payload);
        r.end();
      });
    }

    return { video_url: videoUrl };

  } catch (err) {
    cleanup(bgPath, voPath, subPath, outPath);
    console.error(`[${id}] Error:`, err.message);

    if (webhook_url) {
      // Notify n8n of failure too so the workflow doesn't hang
      try {
        const payload = JSON.stringify({ status: 'error', error: err.message, render_id: id });
        const u = new URL(webhook_url);
        const reqMod = u.protocol === 'https:' ? https : http;
        const options = {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        };
        await new Promise((res, rej) => {
          const r = reqMod.request(options, res);
          r.on('error', rej);
          r.write(payload);
          r.end();
        });
      } catch (_) {}
    }
    throw err;
  }
}

// ─── Cloudinary Upload ────────────────────────────────────────────────────────
function uploadToCloudinary(filePath, id) {
  return new Promise((resolve, reject) => {
    const cloudName  = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey     = process.env.CLOUDINARY_API_KEY;
    const apiSecret  = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      reject(new Error('Missing CLOUDINARY_* environment variables'));
      return;
    }

    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `reels/reel_${id}`;
    const sigStr = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

    const fileData = fs.readFileSync(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

    const buildPart = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const buildFilePart = (name, filename, data) =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`),
        data,
        Buffer.from('\r\n'),
      ]);

    const parts = Buffer.concat([
      Buffer.from(buildPart('api_key', apiKey)),
      Buffer.from(buildPart('timestamp', timestamp)),
      Buffer.from(buildPart('public_id', publicId)),
      Buffer.from(buildPart('signature', signature)),
      Buffer.from(buildPart('resource_type', 'video')),
      buildFilePart('file', `reel_${id}.mp4`, fileData),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${cloudName}/video/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': parts.length,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.secure_url) resolve(json.secure_url);
          else reject(new Error('Cloudinary upload failed: ' + body));
        } catch (e) {
          reject(new Error('Cloudinary parse error: ' + body));
        }
      });
    });
    req.on('error', reject);
    req.write(parts);
    req.end();
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 ReelForge running on :${PORT}`));