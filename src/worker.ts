// ─── Night Shift by Does News | doesnews.com ───────────────────────────────
// Cloudflare Worker — script generator + live dashboard.
//
// Routes:
//   GET  /                     → dashboard UI (password protected)
//   GET  /generate?key=PWD     → trigger generation (browser-safe)
//   GET  /status?key=PWD       → generation status JSON (polled by dashboard)
//   GET  /script?key=PWD&date= → fetch script text from R2

import type { Env, NightShiftOutput, ResponsesAPIRequest, ResponsesAPIResponse } from "./types";
import { fetchAllForecasts, formatWeatherForPrompt } from "./weather";
import { fetchNewsDigest } from "./news";
import { MASTER_PROMPT, buildUserPrompt } from "./prompt";
import { DASHBOARD_HTML } from "./dashboard";

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_MODEL        = "gpt-5.5";
const DEFAULT_HOST         = "Penelope Rose";
const MIN_WORDS            = 5_800;
const MAX_WORDS            = 6_525;
const EXTENSION_TARGET     = 6_100;
const MAX_EXTENSION_PASSES = 2;

// ─── Status helpers ───────────────────────────────────────────────────────────

interface Status {
  state: "idle" | "running" | "done" | "error";
  stage: string;
  date: string;
  word_count: number;
  estimated_minutes: number;
  error: string;
  started_at: string;
  completed_at: string;
}

async function writeStatus(kv: KVNamespace, patch: Partial<Status>): Promise<void> {
  try {
    const raw     = await kv.get("status:latest");
    const current = raw ? (JSON.parse(raw) as Status) : {} as Status;
    await kv.put("status:latest", JSON.stringify({ ...current, ...patch }));
  } catch (_) { /* non-fatal */ }
}

async function readStatus(kv: KVNamespace): Promise<Status> {
  try {
    const raw = await kv.get("status:latest");
    if (raw) return JSON.parse(raw) as Status;
  } catch (_) {}
  return { state: "idle", stage: "idle", date: "", word_count: 0, estimated_minutes: 0, error: "", started_at: "", completed_at: "" };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getTodaySpoken(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York",
  });
}

function getTodayFilename(): string {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${String(et.getMonth()+1).padStart(2,"0")}-${String(et.getDate()).padStart(2,"0")}-${et.getFullYear()}`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function extractResponseText(data: ResponsesAPIResponse): string {
  for (const item of data.output) {
    if (item.type === "message" && item.content) {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) return c.text;
      }
    }
  }
  throw new Error("No output_text in response");
}

function stripFence(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
  return m ? m[1].trim() : raw.trim();
}

// ─── OpenAI: full generation (with web search) ───────────────────────────────

async function callOpenAI(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const body: ResponsesAPIRequest = {
    model, instructions: system, input: user,
    tools: [{ type: "web_search_preview", search_context_size: "high" }],
    max_output_tokens: 16_000, temperature: 0.7,
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.text().catch(() => ""); throw new Error(`OpenAI ${res.status}: ${e.slice(0,400)}`); }
  const data = (await res.json()) as ResponsesAPIResponse;
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  return extractResponseText(data);
}

// ─── OpenAI: extension pass (no web search needed) ───────────────────────────

async function extendScript(apiKey: string, model: string, script: string, wordCount: number): Promise<string> {
  const needed = EXTENSION_TARGET - wordCount;
  const prompt = `You are editing a Night Shift by Does News podcast script.
The script is ${wordCount} words. Minimum required: ${MIN_WORDS} (40 minutes at 145 wpm).
Add ~${needed + 300} words by expanding — with more depth, context, and analysis — these sections:
  • U.S. Politics + Political Trends
  • Power Map
  • International / Iran / Gaza
  • Business / Economy + Cost of Living Check
  • Healthcare + Climate

Rules:
- Do NOT change any facts, names, dates, or quotes.
- Do NOT add new sections.
- Keep ALL [TEN-SECOND SECTION SPACER] markers exactly in place.
- Maintain ElevenLabs formatting (short spoken lines, paragraph spacing).
- Return ONLY the complete extended script as plain text. No JSON. No commentary.

SCRIPT:
${script}`;
  const body: ResponsesAPIRequest = { model, input: prompt, max_output_tokens: 6_000, temperature: 0.6 };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.text().catch(() => ""); throw new Error(`Extend ${res.status}: ${e.slice(0,400)}`); }
  const data = (await res.json()) as ResponsesAPIResponse;
  if (data.error) throw new Error(`Extend: ${data.error.message}`);
  return extractResponseText(data);
}

// ─── Parse & validate ─────────────────────────────────────────────────────────

function parseAndValidate(rawText: string): NightShiftOutput {
  const cleaned = stripFence(rawText);
  let parsed: NightShiftOutput;
  try { parsed = JSON.parse(cleaned) as NightShiftOutput; }
  catch (e) { throw new Error(`JSON parse failed: ${String(e)} — first 400: ${cleaned.slice(0,400)}`); }
  if (!parsed.elevenlabs_script) throw new Error("Missing elevenlabs_script");
  const words = countWords(parsed.elevenlabs_script);
  parsed.self_validation = { word_count: words, estimated_minutes: +(words/145).toFixed(1), within_range: words >= MIN_WORDS && words <= MAX_WORDS };
  return parsed;
}

// ─── R2 save ──────────────────────────────────────────────────────────────────

async function saveToR2(bucket: R2Bucket, script: string, dateStr: string): Promise<string> {
  const key = `Night Shift - ${dateStr}.txt`;
  await bucket.put(key, script, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { show: "Night Shift", network: "Does News", website: "doesnews.com", generated: new Date().toISOString() },
  });
  return key;
}

// ─── Core pipeline ────────────────────────────────────────────────────────────

async function run(env: Env): Promise<void> {
  const model    = env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const hostName = env.HOST_NAME   ?? DEFAULT_HOST;
  const dateStr  = getTodayFilename();
  const dateSp   = getTodaySpoken();
  const kv       = env.STATUS_KV;

  await writeStatus(kv, { state: "running", stage: "started", date: dateStr, started_at: new Date().toISOString(), error: "", word_count: 0 });
  console.log(`[night-shift] Starting for ${dateSp}`);

  // Step 1: Weather
  let weatherBlock = "";
  try {
    await writeStatus(kv, { stage: "weather" });
    const bundle = await fetchAllForecasts(env.TOMORROW_API_KEY);
    weatherBlock = formatWeatherForPrompt(bundle);
    console.log(`[weather] ✓ ${bundle.forecasts.length} cities`);
  } catch (err) {
    console.error("[weather]", err);
    weatherBlock = "WEATHER DATA: Unavailable. Acknowledge briefly and move on.";
  }

  // Step 2: News
  let newsDigest = "";
  try {
    await writeStatus(kv, { stage: "news" });
    newsDigest = await fetchNewsDigest(env.NEWSAPI_KEY);
    console.log(`[news] ✓ ${newsDigest.length} chars`);
  } catch (err) {
    console.error("[news]", err);
  }

  // Step 3: Generate
  await writeStatus(kv, { stage: "generating" });
  const userPrompt = buildUserPrompt({ episodeDateSpoken: dateSp, hostName, weatherBlock, newsDigest });

  let rawText: string;
  try {
    rawText = await callOpenAI(env.OPENAI_API_KEY, model, MASTER_PROMPT, userPrompt);
    console.log(`[openai] ✓ ${rawText.length} chars`);
  } catch (err) {
    const msg = String(err);
    console.error("[openai]", err);
    await writeStatus(kv, { state: "error", stage: "error", error: msg, completed_at: new Date().toISOString() });
    return;
  }

  // Step 4: Parse
  let output: NightShiftOutput;
  try {
    output = parseAndValidate(rawText);
  } catch (err) {
    const msg = String(err);
    console.error("[parse]", err);
    await writeStatus(kv, { state: "error", stage: "error", error: msg, completed_at: new Date().toISOString() });
    return;
  }

  // Step 5: Auto-extend if too short
  let script    = output.elevenlabs_script;
  let wordCount = countWords(script);
  let passes    = 0;

  while (wordCount < MIN_WORDS && passes < MAX_EXTENSION_PASSES) {
    passes++;
    await writeStatus(kv, { stage: passes === 1 ? "extending1" : "extending2" });
    console.log(`[extend] Pass ${passes}: ${wordCount} words → targeting ${EXTENSION_TARGET}`);
    try {
      script    = await extendScript(env.OPENAI_API_KEY, model, script, wordCount);
      wordCount = countWords(script);
      console.log(`[extend] ✓ Now ${wordCount} words`);
    } catch (err) {
      console.error(`[extend] Pass ${passes} failed:`, err);
      break;
    }
  }

  const finalMins = +(wordCount / 145).toFixed(1);

  // Step 6: Save
  await writeStatus(kv, { stage: "saving" });
  try {
    const key = await saveToR2(env.SCRIPTS_BUCKET, script, dateStr);
    console.log(`[r2] ✓ ${key}`);
  } catch (err) {
    const msg = String(err);
    console.error("[r2]", err);
    await writeStatus(kv, { state: "error", stage: "error", error: msg, completed_at: new Date().toISOString() });
    return;
  }

  await writeStatus(kv, {
    state: "done", stage: "done",
    word_count: wordCount, estimated_minutes: finalMins,
    completed_at: new Date().toISOString(),
  });
  console.log(`[night-shift] ✓ Done — ${wordCount} words / ~${finalMins} min`);
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
  async scheduled(_: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url  = new URL(request.url);
    const json = (body: object, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    // Auth
    const pwd      = env.GENERATE_PASSWORD;
    const provided = url.searchParams.get("key") ?? request.headers.get("Authorization")?.replace("Bearer ", "");
    const authed   = !pwd || provided === pwd;

    if (!authed) {
      if (url.pathname === "/") return new Response(
        `<!DOCTYPE html><html><body style="background:#080c14;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
        <div style="font-size:2rem">🌙</div>
        <div style="font-weight:600">Night Shift</div>
        <div style="color:#475569;font-size:0.85rem">Add <code style="color:#60a5fa">?key=PASSWORD</code> to the URL</div>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
      return json({ ok: false, message: "Unauthorized — add ?key=PASSWORD to the URL" }, 401);
    }

    // Dashboard
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Trigger generation
    if (url.pathname === "/generate") {
      ctx.waitUntil(run(env));
      return json({ ok: true, message: "Night Shift generation started." }, 202);
    }

    // Status
    if (url.pathname === "/status") {
      return json(await readStatus(env.STATUS_KV));
    }

    // Script
    if (url.pathname === "/script") {
      const date = url.searchParams.get("date") || getTodayFilename();
      const obj  = await env.SCRIPTS_BUCKET.get(`Night Shift - ${date}.txt`);
      if (!obj) return new Response("Script not found", { status: 404 });
      return new Response(obj.body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return json({ ok: false, message: "Not found" }, 404);
  },
};
