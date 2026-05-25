// ─── Night Shift by Does News | doesnews.com ───────────────────────────────
// NewsAPI.org integration — fetches today's headlines across key categories.
// Provides the AI with a structured starting digest for the script.
// The AI must verify and expand via web_search before treating any item as fact.

// ─── Types ───────────────────────────────────────────────────────────────────

interface NewsAPIArticle {
  source: { id: string | null; name: string };
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
}

interface NewsAPIResponse {
  status: "ok" | "error";
  totalResults?: number;
  articles?: NewsAPIArticle[];
  code?: string;
  message?: string;
}

interface CategoryFetch {
  label: string;
  articles: NewsAPIArticle[];
  error?: string;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

const NEWSAPI_BASE = "https://newsapi.org/v2";
const FETCH_TIMEOUT_MS = 8_000;

async function fetchEndpoint(
  path: string,
  params: Record<string, string>,
  apiKey: string
): Promise<NewsAPIArticle[]> {
  const url = new URL(`${NEWSAPI_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`NewsAPI ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as NewsAPIResponse;

  if (data.status !== "ok") {
    throw new Error(`NewsAPI error: ${data.code} — ${data.message}`);
  }

  return data.articles ?? [];
}

// ─── Category fetch plan ─────────────────────────────────────────────────────
// We use /top-headlines (works on all tiers) for categories.
// /everything (requires paid plan) is used for topic searches with graceful fallback.

async function fetchCategory(
  label: string,
  path: string,
  params: Record<string, string>,
  apiKey: string
): Promise<CategoryFetch> {
  try {
    const articles = await fetchEndpoint(path, params, apiKey);
    return { label, articles };
  } catch (err) {
    console.warn(`[news] Failed to fetch "${label}":`, err);
    return { label, articles: [], error: String(err) };
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function fetchNewsDigest(apiKey: string): Promise<string> {
  const categories = await Promise.all([
    fetchCategory("Top U.S. Headlines", "/top-headlines", {
      country: "us",
      pageSize: "20",
    }, apiKey),

    fetchCategory("Business", "/top-headlines", {
      country: "us",
      category: "business",
      pageSize: "12",
    }, apiKey),

    fetchCategory("Health", "/top-headlines", {
      country: "us",
      category: "health",
      pageSize: "10",
    }, apiKey),

    fetchCategory("Technology", "/top-headlines", {
      country: "us",
      category: "technology",
      pageSize: "8",
    }, apiKey),

    fetchCategory("Science", "/top-headlines", {
      country: "us",
      category: "science",
      pageSize: "6",
    }, apiKey),

    // International: no country filter = broader global coverage
    fetchCategory("International", "/top-headlines", {
      language: "en",
      pageSize: "15",
    }, apiKey),

    // Topic searches — require /everything (paid tier).
    // Gracefully skipped if NewsAPI returns 401/426.
    fetchCategory("Gaza & Middle East", "/everything", {
      q: "Gaza OR Palestine OR Israel OR Hamas",
      language: "en",
      sortBy: "publishedAt",
      pageSize: "10",
    }, apiKey),

    fetchCategory("Iran", "/everything", {
      q: "Iran OR IRGC OR \"Iranian nuclear\"",
      language: "en",
      sortBy: "publishedAt",
      pageSize: "8",
    }, apiKey),

    fetchCategory("Immigration", "/everything", {
      q: "immigration OR deportation OR asylum OR border",
      language: "en",
      sortBy: "publishedAt",
      pageSize: "8",
    }, apiKey),

    fetchCategory("Climate & Environment", "/everything", {
      q: "climate change OR wildfire OR extreme weather OR flood OR EPA",
      language: "en",
      sortBy: "publishedAt",
      pageSize: "8",
    }, apiKey),

    fetchCategory("Labor & Economy", "/everything", {
      q: "workers OR union OR strike OR wages OR layoffs OR cost of living",
      language: "en",
      sortBy: "publishedAt",
      pageSize: "8",
    }, apiKey),
  ]);

  return formatDigest(categories);
}

// ─── Format ───────────────────────────────────────────────────────────────────

function formatArticle(a: NewsAPIArticle): string {
  const source = a.source.name ?? "Unknown";
  const desc   = a.description ? ` — ${a.description.slice(0, 120)}` : "";
  const url    = a.url ? ` [${a.url}]` : "";
  return `  • [${source}] ${a.title}${desc}${url}`;
}

function formatDigest(categories: CategoryFetch[]): string {
  const lines: string[] = [
    "NEWS DIGEST (NewsAPI.org — use as starting context only):",
    "IMPORTANT: Verify and expand every item via web_search before including it in the script.",
    "Do NOT cite this digest as a source. Use it to identify topics, then find primary reporting.",
    "",
  ];

  let anyContent = false;

  for (const cat of categories) {
    if (cat.articles.length === 0) {
      if (cat.error) {
        lines.push(`${cat.label.toUpperCase()}: [fetch error — use web_search for this category]`);
      }
      continue;
    }

    anyContent = true;
    lines.push(`${cat.label.toUpperCase()}:`);
    for (const article of cat.articles.slice(0, 8)) {
      lines.push(formatArticle(article));
    }
    lines.push("");
  }

  if (!anyContent) {
    return "NEWS DIGEST: No headlines fetched. Use web_search for all categories.";
  }

  return lines.join("\n");
}
