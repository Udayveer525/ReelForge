# 🎬 ReelForge — Automated Dark Humor Reels Pipeline

Fully automated Instagram Reels pipeline. Zero manual work after setup.
Posts 2 reels/day. 100% free stack.

---

## Architecture

```
Schedule (9am + 6pm)
  → Postgres (memory — avoids repeat topics)
  → Groq (generates dark fact script)
  → ElevenLabs (deadpan voiceover MP3)
  → ImgBB (hosts MP3 publicly)
  → Pexels API (fetches cinematic background video)
  → ReelForge on Render (FFmpeg renders final .mp4)
  → Cloudinary (hosts final video)
  → Meta Graph API (posts as Reel)
  → Postgres (logs topic)
```

---

## Step 1 — Free Accounts to Create

| Service       | URL                          | What you need          |
|---------------|------------------------------|------------------------|
| Groq          | console.groq.com             | API Key                |
| ElevenLabs    | elevenlabs.io                | API Key (free tier)    |
| ImgBB         | api.imgbb.com                | API Key                |
| Pexels        | pexels.com/api               | API Key                |
| Cloudinary    | cloudinary.com               | Cloud Name, API Key, API Secret |
| Render        | render.com                   | Free account           |
| GitHub        | github.com                   | Repo to deploy from    |

---

## Step 2 — Deploy ReelForge to Render

1. Push this whole folder to a new GitHub repo
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects the Dockerfile — just click Deploy
5. In Environment Variables on the Render dashboard, add:
   - `CLOUDINARY_CLOUD_NAME`  → from your Cloudinary dashboard
   - `CLOUDINARY_API_KEY`     → from your Cloudinary dashboard
   - `CLOUDINARY_API_SECRET`  → from your Cloudinary dashboard
6. Copy your Render service URL (e.g. https://reel-forge-xxxx.onrender.com)

### Keep Render Free Tier Awake

Render's free tier sleeps after 15 min of inactivity. Fix it for free:

1. Go to cron-job.org → create a free account
2. Create a new cron job:
   - URL: `https://your-reel-forge.onrender.com/ping`
   - Schedule: every 5 minutes
3. That's it — your service stays awake 24/7 for free

---

## Step 3 — ElevenLabs Voice

The workflow uses Voice ID `pNInz6obpgDQGcFmaJgB` (Adam — deadpan male voice).

To use a different voice:
1. Go to elevenlabs.io → Voices
2. Find a voice you like → copy its Voice ID
3. Replace `pNInz6obpgDQGcFmaJgB` in the ElevenLabs node URL

Best voices for dark humor:
- **Adam** `pNInz6obpgDQGcFmaJgB` — deep, calm, deadpan ✅
- **Callum** `N2lVS1w4EtoT3dr4eOWO` — slightly darker edge
- **Charlie** `IKne3meq5aSn9XLyUdCD` — conversational, younger

---

## Step 4 — Import n8n Workflow

1. Open your n8n instance
2. Go to Workflows → Import from file
3. Select `n8n-workflow.json`
4. Replace ALL placeholder values (search for `YOUR_`):

| Placeholder                        | Replace with                                  |
|------------------------------------|-----------------------------------------------|
| `YOUR_POSTGRES_CREDENTIAL_ID`      | Your n8n Postgres credential ID               |
| `YOUR_GROQ_BEARER_CREDENTIAL_ID`   | Your n8n Groq Bearer Auth credential ID       |
| `YOUR_ELEVENLABS_API_KEY`          | Your ElevenLabs API key                       |
| `YOUR_IMGBB_KEY`                   | Your ImgBB API key                            |
| `YOUR_PEXELS_API_KEY`              | Your Pexels API key                           |
| `YOUR-REEL-FORGE-SERVICE`          | Your Render service URL (no trailing slash)   |
| `YOUR_INSTAGRAM_USER_ID`           | Your Instagram Business account ID            |
| `YOUR_INSTAGRAM_ACCESS_TOKEN`      | Your long-lived Instagram access token        |

---

## Step 5 — Postgres Table

Make sure your `past_topics` table exists. Run this once:

```sql
CREATE TABLE IF NOT EXISTS past_topics (
  id         SERIAL PRIMARY KEY,
  topic      TEXT NOT NULL,
  format     TEXT NOT NULL DEFAULT 'dark_fact',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Testing ReelForge Locally

```bash
npm install
node src/server.js
```

Then test with curl:

```bash
curl -X POST http://localhost:3000/render-reel \
  -H "Content-Type: application/json" \
  -d '{
    "voiceover_url": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    "background_url": "https://www.pexels.com/download/video/3571264/",
    "caption_text": "After 11 days without sleep your brain starts eating itself. Goodnight."
  }'
```

Expected response:
```json
{ "status": "ok", "video_url": "https://res.cloudinary.com/..." }
```

---

## Free Tier Limits (Monthly)

| Service     | Free Limit              | Your Usage (2/day)     | Status  |
|-------------|-------------------------|------------------------|---------|
| Groq        | Unlimited (rate limited)| ~60 requests/mo        | ✅ Fine |
| ElevenLabs  | 10,000 chars/mo         | ~3,600 chars/mo        | ✅ Fine |
| ImgBB       | Unlimited               | 60 uploads/mo          | ✅ Fine |
| Pexels      | 200 req/hour            | 60 requests/mo         | ✅ Fine |
| Cloudinary  | 25 GB storage           | ~3 GB/mo               | ✅ Fine |
| Render      | 750 hrs/mo              | 720 hrs/mo             | ✅ Fine |

---

## Folder Structure

```
reel-forge/
├── src/
│   └── server.js          ← Main Express + FFmpeg service
├── temp/                  ← Temp files during rendering (auto-cleaned)
├── Dockerfile             ← Installs FFmpeg, runs on Render
├── render.yaml            ← Render deployment config
├── package.json
├── .gitignore
├── n8n-workflow.json      ← Import this into n8n
└── README.md
```

---

## Troubleshooting

**FFmpeg fails on Render**
→ Check Render logs for the exact FFmpeg error
→ Usually a codec issue — the Dockerfile uses `libx264` which is always available

**ElevenLabs returns 401**
→ Check that the `xi-api-key` header has the correct key (not Bearer format)

**Instagram returns `Media posted too fast`**
→ Increase the Wait node from 30s to 60s

**Pexels returns no portrait videos**
→ Try broader search terms like `"dark night"`, `"fog"`, `"storm"`, `"empty street"`

**Render service URL times out**
→ The free tier may be asleep — the first request after sleep takes ~30s
→ Make sure cron-job.org ping is set up correctly