// DuckDuckGo adapter — the real adapter at the SearchProvider seam.
//
// Two implementations behind one interface:
//   1. uvx ddgs — TLS fingerprinting, VQD tokens, no captcha (primary)
//   2. HTML scraping — fallback when uvx unavailable
//
// Auto-installs uv on first use if missing.

import type { SearchOptions, SearchResult } from "./search.ts";
import { hasUvx, installUv, searchViaDdgs } from "./ddgs-uv.ts";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 25_000;

// ── Degraded-mode surfacing ─────────────────────────────────────────────────

export type DdgsFallbackReason = "no-uv" | "ddgs-failed";

// The ddgs and HTML-scraping providers sit behind identical output, but their
// quality differs (captchas, missing TLS fingerprinting). Append a one-line
// notice to fallback results so the degraded mode is visible to the agent.
export function withDdgsNotice(
  results: SearchResult[],
  reason: DdgsFallbackReason,
): SearchResult[] {
  if (results.length === 0) return results;
  const note = reason === "no-uv"
    ? "HTML fallback used — install uv (https://docs.astral.sh/uv/) for higher-quality results"
    : "ddgs search failed — HTML fallback used, results may include captchas";
  const noted = results.slice();
  const last = noted[noted.length - 1]!;
  noted[noted.length - 1] = { ...last, snippet: `${last.snippet}\n\n[DuckDuckGo: ${note}]` };
  return noted;
}

// ── Public interface ─────────────────────────────────────────────────────────

export async function searchDuckDuckGo(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  // Primary: uvx ddgs (TLS fingerprinting, no captcha)
  if (hasUvx()) {
    try {
      return searchViaDdgs(query, options);
    } catch {
      // ddgs failed, fall through to HTML scraping
      return withDdgsNotice(await searchViaHtml(query, options), "ddgs-failed");
    }
  }

  // Fallback: HTML scraping (may get captcha)
  return withDdgsNotice(await searchViaHtml(query, options), "no-uv");
}

async function searchViaHtml(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  // Build site: and -site: operators — DDG filters during search
  // instead of us filtering after. Much more precise.
  const includeDomains = (options.domains ?? [])
    .filter((d) => !d.startsWith("-") && d.length > 0);
  const excludeDomains = (options.domains ?? [])
    .filter((d) => d.startsWith("-") && d.length > 1)
    .map((d) => d.slice(1));

  const siteOps: string[] = [];
  if (includeDomains.length > 0) {
    siteOps.push(includeDomains.map((d) => `site:${d}`).join(" OR "));
  }
  if (excludeDomains.length > 0) {
    siteOps.push(excludeDomains.map((d) => `-site:${d}`).join(" "));
  }
  const siteQuery = siteOps.length > 0 ? `${query} ${siteOps.join(" ")}` : query;

  const url = new URL(DDG_HTML_URL);
  url.searchParams.set("q", siteQuery);
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
