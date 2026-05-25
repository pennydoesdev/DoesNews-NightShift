// ─── Night Shift by Does News | doesnews.com ───────────────────────────────
// Cloudflare Worker — Night Shift script generator.
//
// Triggered by a cron job. On each run:
//   1. Fetch weather forecasts from Tomorrow.io for major US metros
//   2. Fetch today's headlines from NewsAPI.org
//   3. Build the Night Shift prompt (master + user, with weather + news digest)
//   4. Call the OpenAI Responses API (gpt-5.5) with web search enabled
//   5. Parse the JSON output and extract elevenlabs_script
//   6. Save the script as a .txt file to R2 ("Night Shift - MM-DD-YYYY.txt")
//
// All secrets are stored as Cloudflare Worker secrets (wrangler secret put).
// See README.md for setup instructions.

import type {
  Env,
  NightShiftOutput,
  ResponsesAPIRequest,
  ResponsesAPIResponse,
} from "./types";
import { fetchAllForecasts, formatWeatherForPrompt } from "./weather";
import { fetchNewsDigest } from "./news";
import { MASTER_PROMPT, buildUserPrompt } from "./prompt";

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_HOST  = "Penelope Rose";

// At 145 wpm, a 29-31 minute script is 4,100–4,500 words.
const MIN_WORDS = 4_100;
const MAX_WORDS = 4_500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Format today's date in "Month DD, YYYY" spoken form.
 * e.g. "May 25, 2026"
 */
function getTodaySpoken(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/**
 * Format today's date as MM-DD-YYYY for the R2 filename.
 * e.g. "05-25-2026"
 */
function getTodayFilename(): string {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mm   = String(et.getMonth() + 1).padStart(2, "0");
  const dd   = String(et.getDate()).padStart(2, "0");
  const yyyy = et.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

/**
 * Count words in a string (rough estimate matching the AI's approximate count).
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Extract the assistant's text output from an OpenAI Responses API response.
 */
function extractResponseText(data: ResponsesAPIResponse): string {
  for (const item of data.output) {
    if (item.type === "message" && item.content) {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) {
          return c.text;
        }
      }
    }
  }
  throw new Error("No output_text found in OpenAI Responses API response");
}

/**
 * Strip a JSON code fence if the model returned one despite being told not to.
 */
function stripMarkdownFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
  return fenced ? fenced[1].trim() : raw.trim();
}

/**
 * Call the OpenAI Responses API and return the raw text output.
 * Uses gpt-5.5 with the web_search_preview built-in tool.
 */
async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const body: ResponsesAPIRequest = {
    model,
    instructions: systemPrompt,
    input: userPrompt,
    tools: [
      {
        type: "web_search_preview",
        search_context_size: "high",
      },
    ],
    // 4,500 words of script + JSON structure ≈ ~9,000–11,000 tokens output
    max_output_tokens: 12_000,
    temperature: 0.7,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // No AbortSignal — Cloudflare Workers Unbound handles wall-clock limits.
    // OpenAI calls with web search can take 60–180 seconds; Unbound supports up to 15 min.
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    throw new Error(`OpenAI API error ${response.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await response.json()) as ResponsesAPIResponse;

  if (data.error) {
    throw new Error(
      `OpenAI API error: ${data.error.message} (${data.error.code})`
    );
  }

  return extractResponseText(data);
}

/**
 * Parse and validate the JSON output from the AI.
 * Returns the parsed NightShiftOutput.
 */
function parseAndValidate(rawText: string): NightShiftOutput {
  const cleaned = stripMarkdownFence(rawText);
  let parsed: NightShiftOutput;

  try {
    parsed = JSON.parse(cleaned) as NightShiftOutput;
  } catch (e) {
    throw new Error(
      `JSON parse failed: ${String(e)}\nRaw text (first 500 chars): ${cleaned.slice(0, 500)}`
    );
  }

  if (!parsed.elevenlabs_script) {
    throw new Error("Parsed JSON is missing the required elevenlabs_script field");
  }

  const words      = countWords(parsed.elevenlabs_script);
  const estMinutes = +(words / 145).toFixed(1);

  parsed.self_validation = {
    word_count:        words,
    estimated_minutes: estMinutes,
    within_range:      words >= MIN_WORDS && words <= MAX_WORDS,
  };

  if (!parsed.self_validation.within_range) {
    console.warn(
      `[validate] ⚠ Script word count ${words} is outside the target range ` +
      `${MIN_WORDS}–${MAX_WORDS}. Proceeding — manual review recommended.`
    );
  } else {
    console.log(`[validate] ✓ Script OK — ${words} words / ~${estMinutes} min`);
  }

  return parsed;
}

/**
 * Save the ElevenLabs script as a plain text file to Cloudflare R2.
 * Filename format: "Night Shift - MM-DD-YYYY.txt"
 */
async function saveToR2(
  bucket: R2Bucket,
  script: string,
  dateStr: string
): Promise<string> {
  const key = `Night Shift - ${dateStr}.txt`;

  await bucket.put(key, script, {
    httpMetadata: {
      contentType: "text/plain; charset=utf-8",
    },
    customMetadata: {
      show:      "Night Shift",
      network:   "Does News",
      website:   "doesnews.com",
      generated: new Date().toISOString(),
    },
  });

  console.log(`[r2] ✓ Saved: ${key}`);
  return key;
}

// ─── Core pipeline ────────────────────────────────────────────────────────────

async function run(env: Env): Promise<void> {
  const model    = env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const hostName = env.HOST_NAME   ?? DEFAULT_HOST;
  const dateStr  = getTodayFilename(); // "05-25-2026"
  const dateSp   = getTodaySpoken();  // "May 25, 2026"

  console.log(`[night-shift] Starting generation for ${dateSp} (model: ${model})`);

  // ── Step 1: Fetch weather from Tomorrow.io ────────────────────────────────
  let weatherBlock = "";
  try {
    console.log("[weather] Fetching forecasts from Tomorrow.io…");
    const bundle = await fetchAllForecasts(env.TOMORROW_API_KEY);
    weatherBlock = formatWeatherForPrompt(bundle);
    console.log(
      `[weather] ✓ ${bundle.forecasts.length} cities / ${bundle.fetchErrors.length} errors`
    );
  } catch (err) {
    console.error("[weather] Fatal fetch error:", err);
    weatherBlock =
      "WEATHER DATA: Unavailable due to an API error. Acknowledge this briefly and move on.";
  }

  // ── Step 2: Fetch news digest from NewsAPI.org ───────────────────────────
  let newsDigest = "";
  try {
    console.log("[news] Fetching headlines from NewsAPI.org…");
    newsDigest = await fetchNewsDigest(env.NEWSAPI_KEY);
    console.log(`[news] ✓ Digest ready (${newsDigest.length} chars)`);
  } catch (err) {
    console.error("[news] Fetch error:", err);
    newsDigest = "";  // non-fatal — AI will rely on web_search
  }

  // ── Step 3: Build prompts ─────────────────────────────────────────────────
  const userPrompt = buildUserPrompt({
    episodeDateSpoken: dateSp,
    hostName,
    weatherBlock,
    newsDigest,
  });

  // ── Step 4: Call OpenAI Responses API ────────────────────────────────────
  console.log(`[openai] Calling Responses API (${model})…`);
  let rawText: string;
  try {
    rawText = await callOpenAI(env.OPENAI_API_KEY, model, MASTER_PROMPT, userPrompt);
    console.log(`[openai] ✓ Response received (${rawText.length} chars)`);
  } catch (err) {
    console.error("[openai] API call failed:", err);
    throw err;
  }

  // ── Step 5: Parse & validate ──────────────────────────────────────────────
  let output: NightShiftOutput;
  try {
    output = parseAndValidate(rawText);
  } catch (err) {
    console.error("[parse] Failed to parse AI output:", err);
    console.error("[parse] Raw text (first 1,000 chars):", rawText.slice(0, 1_000));
    throw err;
  }

  // ── Step 6: Save to R2 ───────────────────────────────────────────────────
  try {
    const key = await saveToR2(env.SCRIPTS_BUCKET, output.elevenlabs_script, dateStr);
    console.log(`[night-shift] ✓ Done — saved to R2: ${key}`);
  } catch (err) {
    console.error("[r2] Upload failed:", err);
    throw err;
  }
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
  /**
   * Cron trigger handler — runs on the schedule defined in wrangler.toml.
   * ctx.waitUntil() keeps the Worker alive for the full async pipeline.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(run(env));
  },

  /**
   * HTTP handler for manual / CI triggers.
   * POST /generate → fires generation, returns 202 immediately.
   * Any other path  → 404.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/generate") {
      ctx.waitUntil(run(env));
      return new Response(
        JSON.stringify({ ok: true, message: "Night Shift generation started" }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        ok: false,
        message: "Night Shift generator — POST /generate to trigger manually",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  },
};
