// DuckDuckGo adapter — the real adapter at the SearchProvider seam.
//
// Large implementation (HTML scraping, regex parsing, entity decoding,
// redirect URL resolution) behind the small searchDuckDuckGo() interface.
// This adapter is always available: no API key, no MCP, no config.

import type { SearchOptions, SearchResult } from "./search.ts";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 25_000;

// ── Public interface ─────────────────────────────────────────────────────────

export async function searchDuckDuckGo(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const url = new URL(DDG_HTML_URL);
  url.searchParams.set("q", query);
  if (options.recency) {
    const map: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
    url.searchParams.set("df", map[options.recency] ?? "");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; pi-reader/0.2)",
      Accept: "text/html",
    },
    signal: AbortSignal.any(
      options.signal ? [AbortSignal.timeout(TIMEOUT_MS), options.signal] : [AbortSignal.timeout(TIMEOUT_MS)],
    ),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);

  const html = await res.text();
  const results = parseResults(html, options);

  if (results.length === 0) {
    throw new Error("DuckDuckGo returned no parseable results");
  }
  return results;
}

// ── Parsing internals ────────────────────────────────────────────────────────
// Regex-based parsing of DDG's HTML endpoint. No DOM library needed.
// Tested at the seam via exported parseResults.

export function parseResults(
  html: string,
  options: Pick<SearchOptions, "numResults" | "domains"> = {},
): SearchResult[] {
  const limit = options.numResults ?? 10;
  const allowedDomains = (options.domains ?? [])
    .filter((d) => !d.startsWith("-") && d.length > 0);
  const blockedDomains = (options.domains ?? [])
    .filter((d) => d.startsWith("-"))
    .map((d) => d.slice(1))
    .filter((d) => d.length > 0);

  const results: SearchResult[] = [];
  // Split on each result block. result--ad is an ad; skip it.
  const blocks = html.split(/<div\s+class="result(?:\s|")/);

  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const block = blocks[i]!;

    // Skip ad blocks (DDG marks them with "result--ad" in the outer div)
    if (block.slice(0, 80).includes("result--ad")) continue;

    // Title anchor: <a rel="nofollow" class="result__a" href="...">TITLE</a>
    const titleMatch = block.match(
      /<a\s[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1]!)).trim() : "";
    if (!title) continue;

    // Redirect URL from href (contains uddg= param)
    const hrefMatch = block.match(
      /<a\s[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"/i,
    );
    const url = hrefMatch ? decodeRedirectUrl(hrefMatch[1]!) : null;
    if (!url) continue;

    // Domain filter
    if (!matchesDomains(url, allowedDomains, blockedDomains)) continue;

    // Snippet: first text after class="result__snippet"
    const snippetMatch = block.match(
      /class="[^"]*\bresult__snippet\b[^"]*"[\s\S]*?>([\s\S]*?)<\/(?:a|div)>/i,
    );
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1]!)).replace(/\s+/g, " ").trim()
      : "";

    results.push({ title, url, snippet });
  }
  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&rsquo;": "\u2019",
  "&lsquo;": "\u2018",
  "&rdquo;": "\u201d",
  "&ldquo;": "\u201c",
};

function decodeEntities(s: string): string {
  return s.replace(
    /&[a-zA-Z0-9#]+;/g,
    (entity) => ENTITY_MAP[entity] ?? entity,
  );
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function decodeRedirectUrl(href: string): string | null {
  try {
    const base = new URL(DDG_HTML_URL);
    const link = new URL(href, base);
    // DDG wraps destination URLs in the uddg query param
    const dest = link.searchParams.get("uddg");
    const target = dest ?? href;
    const url = new URL(target, base);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    return null;
  } catch {
    return null;
  }
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomains(
  url: string,
  allowed: string[],
  blocked: string[],
): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (allowed.length > 0 && !allowed.some((d) => hostMatchesDomain(hostname, d))) return false;
    if (blocked.some((d) => hostMatchesDomain(hostname, d))) return false;
    return true;
  } catch {
    return true;
  }
}
