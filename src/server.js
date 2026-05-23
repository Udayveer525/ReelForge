const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '50mb' })); // MP3s can be ~3-5MB as base64

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

// Write base64 audio string to a local file (when voiceover comes from n8n directly)
function writeBase64Audio(base64String, dest) {
  // Strip any data-URI prefix e.g. "data:audio/mpeg;base64,..." if present
  const clean = base64String.includes(',') ? base64String.split(',')[1] : base64String;
  const buffer = Buffer.from(clean, 'base64');
  if (buffer.length < 100) throw new Error(`Decoded audio is only ${buffer.length} bytes — base64 string was likely empty or corrupt`);
  fs.writeFileSync(dest, buffer);
  console.log(`Audio written: ${buffer.length} bytes → ${dest}`);
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
 *   "voiceover_base64": "https://...",   // ElevenLabs MP3
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
  const { voiceover_base64, background_url, caption_text, webhook_url } = req.body;

  if (!voiceover_base64 || !background_url || !caption_text) {
    return res.status(400).json({ error: 'Missing voiceover_base64, background_url, or caption_text' });
  }

  // If a webhook URL is given, respond immediately and process in background
  if (webhook_url) {
    res.json({ status: 'processing', message: 'Reel rendering started. Webhook will fire when done.' });
    processReel({ voiceover_base64, background_url, caption_text, webhook_url });
  } else {
    // Synchronous mode — wait for the reel and return the URL
    try {
      const result = await processReel({ voiceover_base64, background_url, caption_text });
      res.json({ status: 'ok', video_url: result.video_url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── Core rendering logic ─────────────────────────────────────────────────────
async function processReel({ voiceover_base64, background_url, caption_text, webhook_url }) {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const bgPath  = path.join(TEMP_DIR, `bg_${id}.mp4`);
  const voPath  = path.join(TEMP_DIR, `vo_${id}.mp3`);
  const subPath = path.join(TEMP_DIR, `sub_${id}.srt`);
  const outPath = path.join(TEMP_DIR, `reel_${id}.mp4`);

  try {
    // Audio: accept base64 string (from n8n filesystem binary mode)
    // or a public URL as fallback
    if (voiceover_base64 && !voiceover_base64.startsWith('http')) {
      console.log(`[${id}] Writing base64 voiceover to disk...`);
      writeBase64Audio(voiceover_base64, voPath);
    } else if (voiceover_base64 && voiceover_base64.startsWith('http')) {
      console.log(`[${id}] Downloading voiceover from URL...`);
      await downloadFile(voiceover_base64, voPath);
    } else {
      throw new Error('Must provide voiceover_base64 (base64 string or http URL)');
    }
    console.log(`[${id}] Downloading background video...`);
    await downloadFile(background_url, bgPath);

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

    // ── Build ASS subtitle file — word-by-word karaoke style ──────────────
    // ASS gives per-word font sizing and colour — not possible in SRT
    const words = caption_text.split(/\s+/);
    const secPerWord = audioDuration / words.length;

    // Timecode helper for ASS format (h:mm:ss.cs — centiseconds)
    const toASS = (s) => {
      const h  = Math.floor(s / 3600);
      const m  = Math.floor((s % 3600) / 60);
      const sc = Math.floor(s % 60);
      const cs = Math.round((s % 1) * 100);
      return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
    };

    // Auto-size: long words shrink so they never overflow 720px width
    const fontSizeFor = (word) => {
      const len = word.length;
      if (len <= 8)  return 52;
      if (len <= 12) return 44;
      if (len <= 16) return 36;
      return 28; // e.g. "nucleosynthesis" (15 chars) → 36, longer → 28
    };

    // 2 words per card — fast, dynamic, still readable
    const CHUNK = 2;
    const assEvents = [];
    for (let i = 0; i < words.length; i += CHUNK) {
      const chunk    = words.slice(i, i + CHUNK);
      const startSec = i * secPerWord;
      const endSec   = Math.min((i + CHUNK) * secPerWord, audioDuration);
      const fontSize = Math.min(...chunk.map(fontSizeFor));
      const text     = chunk.join(' ');
      // {\an2}=bottom-center anchor, {\fs}=font size, {\b1}=bold
      // {\c}=white fill, {\3c}=black outline, {\shad3}=drop shadow, {\bord4}=thick border
      assEvents.push(
        `Dialogue: 0,${toASS(startSec)},${toASS(endSec)},Karaoke,,0,0,0,,{\\an2}{\\fs${fontSize}}{\\b1}{\\c&H00FFFFFF&}{\\3c&H00000000&}{\\shad3}{\\bord4}${text}`
      );
    }

    // ASS header — PlayRes matches our 720x1280 output
    const assContent = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 720',
      'PlayResY: 1280',
      'WrapStyle: 0',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Karaoke,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,2,0,1,4,3,2,40,40,120,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...assEvents,
    ].join('\n');

    const assPath = subPath.replace('.srt', '.ass');
    fs.writeFileSync(assPath, assContent);

    // ── FFmpeg ────────────────────────────────────────────────────────────────
    // drawbox: dark semi-transparent strip in subtitle zone (y=920 to bottom)
    // Eliminates need for vignette — lighter on CPU, more targeted
    const safeAssPath = assPath.replace(/\\/g, '/').replace(/'/g, "'\\''" );
    const ffmpegCmd = [
      `ffmpeg -y`,
      `-stream_loop -1 -i "${bgPath}"`,
      `-i "${voPath}"`,
      `-t ${videoDuration}`,
      `-vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,` +
        `drawbox=x=0:y=920:w=720:h=360:color=black@0.55:t=fill,` +
        `ass='${safeAssPath}'"`,
      `-c:v libx264 -preset ultrafast -crf 26`,
      `-c:a aac -b:a 128k`,
      `-map 0:v:0 -map 1:a:0`,
      `-movflags +faststart`,
      `-threads 1`,
      `"${outPath}"`,
    ].join(' ');

    console.log(`[${id}] Running FFmpeg...`);
    await runFFmpeg(ffmpegCmd);
    console.log(`[${id}] FFmpeg done ✅`);

    // ── Upload to Cloudinary ──────────────────────────────────────────────
    const videoUrl = await uploadToCloudinary(outPath, id);
    console.log(`[${id}] Uploaded: ${videoUrl}`);

    const assPath2 = subPath.replace('.srt', '.ass');
    cleanup(bgPath, voPath, subPath, assPath2, outPath);

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
    const assPath2 = subPath.replace('.srt', '.ass');
    cleanup(bgPath, voPath, subPath, assPath2, outPath);
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