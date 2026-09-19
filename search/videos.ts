// videos.ts — the videos vertical adapter: `provider: "videos"`, backed by a
// direct DuckDuckGo v.js client (free, keyless). Explicit-only: never chosen
// by auto-routing ("find a video about" intent hijacking text searches is a
// determinism risk), so this adapter lives outside the auto chain and is
// dispatched only when the agent names it.
//
// Why not ddgs (the news/images route): ddgs's videos engine is the only one
// behind that vertical, and its HTTP client (primp, TLS-fingerprint-spoofed)
// is 403-banned from v.js. The endpoint itself is open — verified live with a
// plain browser UA — so this adapter runs two plain GETs:
//
//   1. GET duckduckgo.com/?q=<query>          → extract the VQD token
//   2. GET duckduckgo.com/v.js?...&vqd=<vqd>  → JSON results
//
// That is the same seam shape as the HTML text fallback in duckduckgo.ts
// (plain fetch, browser UA, parse). The fragile seam is the VQD regex —
// pinned by fixture, and failures surface as actionable in-band errors, not
// fake results. No degrade-to-text: text results cannot substitute for
// videos, and a 403 from a fingerprint ban is not a retry-recoverable state —
// the error names the cause and the text + `domains: ["youtube.com"]`
// workaround instead.

import type { SearchOptions, SearchResult } from "./search.ts";
import { REGENCY_TO_TIMELIMIT } from "./ddgs-uv.ts";

const TIMEOUT_MS = 25_000;
// Browser-like UA, no TLS tricks: ddgs's ban proves DDG fingerprints
// aggressively, so this client must stay boring to avoid earning the same flag.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Raw shape (v.js rows — live-verified 2026-09-19) ──────────────────────────
// Only the fields normalization reads are named; the rest (embed_html,
// embed_url, image_token, images, description, thumbnail_*) are dropped
// no-ops — nothing the agent does with a video needs them.

export interface VjsVideoRow {
  title?: string;
  /** The watch URL — the thing the agent acts on. */
  content?: string;
  duration?: string;
  published?: string;
  publisher?: string;
  uploader?: string;
  statistics?: { viewCount?: number };
  [key: string]: unknown;
}

// ── Pure seam: VQD extraction ─────────────────────────────────────────────────

/** Extract the VQD token from the duckduckgo.com/?q= response HTML.
 *  Regex-on-markup — the known-fragile seam; pinned by fixture. Returns null
 *  when the token is absent (challenge page, markup change). Pure; exported
 *  for tests. */
export function extractVqd(html: string): string | null {
  const m = html.match(/vqd="([\d-]+)"/);
  return m?.[1] ?? null;
}

// ── Pure seam: request params ──────────────────────────────────────────────────

/** Build the v.js query params. `f` packs filters as a 4-slot comma string —
 *  only the publishedAfter slot binds (recency d/w/m/y); the rest stay empty.
 *  Page 1 sends no `s` (DDG's offset is 0-based, 60 per page). Pure; exported
 *  for tests. */
export function buildVideoParams(query: string, vqd: string, options: SearchOptions): URLSearchParams {
  const recencyCode = options.recency ? REGENCY_TO_TIMELIMIT[options.recency] ?? null : null;
  const params = new URLSearchParams({
    l: "us-en",
    o: "json",
    q: query,
    vqd,
    p: "-1", // moderate safesearch — never surfaced
    f: recencyCode ? `publishedAfter:${recencyCode},,,` : ",,,",
  });
  if (options.page && options.page > 1) {
    params.set("s", String((options.page - 1) * 60));
  }
  return params;
}

// ── Pure seam: normalization (agent-POV) ──────────────────────────────────────

/** Compact view count: 1216317 → "1.2M", 592793 → "592.8k", 41 → "41".
 *  Non-finite/absent → null. Pure; exported for tests. */
export function formatViews(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

function trim(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** v.js rows → SearchResult. `url`←`content` (the watch URL — the agent acts
 *  on the video, not a page about it), `title` verbatim, `author`←`uploader`
 *  (falling back to `publisher`), `publishedDate` verbatim (clean ISO and
 *  source junk pass through, same rule as news), `snippet`←
 *  `"duration · N views · via uploader"` — tokens join with " · "; missing
 *  fields tolerated. Rows without a watch URL are dropped — no url, no
 *  action. Pure; exported for tests. */
export function normalizeVideoResults(rows: VjsVideoRow[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const r of rows) {
    if (!r.content) continue;
    const tokens: string[] = [];
    if (r.duration) tokens.push(r.duration);
    const views = formatViews(r.statistics?.viewCount);
    if (views) tokens.push(`${views} views`);
    const via = r.uploader || r.publisher;
    if (via) tokens.push(`via ${via}`);
    results.push({
      title: r.title ?? "",
      url: r.content,
      snippet: tokens.join(" · "),
      ...(r.published ? { publishedDate: r.published } : {}),
      ...(r.uploader || r.publisher ? { author: r.uploader || r.publisher } : {}),
    });
  }
  return results;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface VideosDeps {
  fetchVqd: (query: string, signal?: AbortSignal) => Promise<string | null>;
  fetchVideoRows: (query: string, vqd: string, options: SearchOptions) => Promise<VjsVideoRow[]>;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, text/html" },
    signal: AbortSignal.any(
      signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
    ),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  return res.text();
}

export const defaultVideosDeps: VideosDeps = {
  async fetchVqd(query, signal) {
    return extractVqd(await fetchText(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, signal));
  },
  async fetchVideoRows(query, vqd, options) {
    const params = buildVideoParams(query, vqd, options);
    const text = await fetchText(`https://duckduckgo.com/v.js?${params}`, options.signal);
    try {
      const data = JSON.parse(text) as { results?: VjsVideoRow[] };
      return data.results ?? [];
    } catch {
      throw new Error("DuckDuckGo video endpoint returned non-JSON (challenge page?)");
    }
  },
};

/** Search the videos vertical. Throws when the path is unavailable — no text
 *  substitute exists, so the entry surfaces the error as an actionable
 *  in-band message instead of fake results. */
export async function searchVideos(
  query: string,
  options: SearchOptions = {},
  deps: VideosDeps = defaultVideosDeps,
): Promise<SearchResult[]> {
  const vqd = await deps.fetchVqd(query, options.signal);
  if (!vqd) {
    throw new Error(
      "DuckDuckGo video endpoint unavailable (no VQD token — challenge page or markup change). " +
      'Workaround: text search with domains: ["youtube.com"]',
    );
  }
  let rows: VjsVideoRow[];
  try {
    rows = await deps.fetchVideoRows(query, vqd, options);
  } catch (err) {
    throw new Error(
      `DuckDuckGo video search failed (${err instanceof Error ? err.message : String(err)}). ` +
      'Workaround: text search with domains: ["youtube.com"]',
    );
  }
  const results = normalizeVideoResults(rows);
  if (results.length === 0) {
    throw new Error("DuckDuckGo video search returned no parseable results");
  }
  return results.slice(0, options.numResults ?? 10);
}
