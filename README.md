# Night Shift — Does News Script Generator

Automated nightly script generator for **Night Shift** by [Does News](https://doesnews.com).

Runs as a Cloudflare Worker on a cron schedule. Each night at **11:00 PM UTC (6 PM ET)** it:
1. Fetches a 3-day weather forecast for 12 major US metros from **Tomorrow.io**
2. Fetches today's top headlines from **NewsAPI.org** across 11 categories
3. Calls the **OpenAI Responses API** (`gpt-5.5`) with the Night Shift master prompt + live web search
4. Validates the generated 30-minute script (4,100–4,500 words)
5. Saves the ElevenLabs-ready script to **Cloudflare R2** as `Night Shift - MM-DD-YYYY.txt`

---

## Requirements

- [Cloudflare account](https://dash.cloudflare.com) with Workers & R2 enabled
- Worker upgraded to **Workers Unbound** (OpenAI calls can take 60–180 seconds; see below)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
- OpenAI API key with access to `gpt-5.5` and the Responses API
- [Tomorrow.io](https://www.tomorrow.io) API key (free tier works, ≤25 requests/hour)
- [NewsAPI.org](https://newsapi.org) API key
  - Free tier: `/top-headlines` only, 100 req/day, 15-min delay — works for general headlines
  - Developer/Business tier: `/everything` endpoint + real-time (recommended for production)

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/pennydoesdev/DoesNews-NightShift.git
cd DoesNews-NightShift
npm install
```

### 2. Create the R2 bucket

```bash
wrangler r2 bucket create doesnews-nightshift
```

The bucket name is already set to `doesnews-nightshift` in `wrangler.toml`.

### 3. Set secrets

```bash
wrangler secret put OPENAI_API_KEY
# paste your OpenAI API key when prompted

wrangler secret put TOMORROW_API_KEY
# paste your Tomorrow.io API key when prompted

wrangler secret put NEWSAPI_KEY
# paste your NewsAPI.org key when prompted

# Optional overrides:
wrangler secret put OPENAI_MODEL
# paste: gpt-5.5

wrangler secret put HOST_NAME
# paste: Penelope Rose
```

### 4. Review cron time (optional)

The default cron in `wrangler.toml` is `0 23 * * *` = **11:00 PM UTC = 6:00 PM Eastern (EST)**.  
During EDT (summer), this fires at 7:00 PM Eastern. Adjust if needed.

### 5. Upgrade to Workers Unbound

The OpenAI Responses API with web search can run for 60–180 seconds.  
Standard Workers have a 30-second wall-clock limit — too short for this pipeline.

Upgrade in the Cloudflare dashboard:  
**Workers & Pages → night-shift-generator → Settings → Usage Model → Unbound**

### 6. Deploy

```bash
wrangler deploy
```

---

## Manual trigger (testing)

```bash
# Trigger generation via HTTP (returns 202 immediately; generation runs in background)
curl -X POST https://night-shift-generator.<your-account>.workers.dev/generate
```

Stream live logs:

```bash
wrangler tail
```

---

## Output

Scripts are saved to R2 as:

```
Night Shift - MM-DD-YYYY.txt
```

Example: `Night Shift - 05-25-2026.txt`

The file contains the ElevenLabs-ready spoken script only — no JSON wrapper, no production metadata.

---

## Script format

- **Runtime target:** 30 minutes (~4,200–4,400 words at 145 wpm)
- **Opener:** `"Good evening, tonight is [date]. I am Penelope Rose, and this is Night Shift from Does News."`
- **Weather:** Tomorrow + next 2 days only — today's weather is **never** included
- **News sources:** NewsAPI.org digest + OpenAI web_search_preview for verification & depth
- **Tone:** Progressive, working-class-centered, factual
- **Sections include:** Power Map, Cost of Living Check, What Comes Next, nightly riddle
- **Spacers:** `[TEN-SECOND SECTION SPACER]` between every section for post-production editing

---

## Architecture

```
Cron trigger: 0 23 * * * (11 PM UTC / 6 PM ET)
       │
       ▼
 weather.ts — Tomorrow.io API → 12 city forecasts (tomorrow + 2 days, never today)
       │
       ▼
 news.ts — NewsAPI.org → headlines across 11 categories (politics, business,
           health, tech, science, international, Gaza, Iran, immigration, climate, labor)
       │
       ▼
 prompt.ts — master prompt + user prompt (weather data + news digest injected)
       │
       ▼
 OpenAI Responses API (gpt-5.5 + web_search_preview)
       │
       ▼
 Parse JSON → validate word count (4,100–4,500) → extract elevenlabs_script
       │
       ▼
 Cloudflare R2 (doesnews-nightshift) → "Night Shift - MM-DD-YYYY.txt"
```

---

## Weather API note

Tomorrow.io `daily[0]` is always **today** — intentionally skipped.  
The worker uses `daily[1]` (tomorrow), `daily[2]`, and `daily[3]` for the 3-day outlook.  
This ensures Night Shift never airs today's weather, which is behind the listener by airtime.

---

## NewsAPI note

The `/everything` endpoint (topic-specific searches for Gaza, Iran, immigration, climate, labor)  
requires a **paid NewsAPI plan**. On the free tier, those categories are skipped gracefully  
and the AI falls back to `web_search_preview` for those topics — no script failures.

---

## License

Private — Does News / doesnews.com
