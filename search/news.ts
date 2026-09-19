// news.ts — the news vertical adapter: `provider: "news"`, backed by the ddgs
// news subcommand (bing/duckduckgo/yahoo engines — free, keyless).
//
// Normalization is verbatim and invents nothing: dates pass through exactly as
// the engines emit them (clean ISO and source junk alike); the outlet becomes
// `author`. When the ddgs news path is unavailable (uvx missing or the call
// failing) the adapter degrades to text search with the same query and window,
// a visible notice, and a degraded flag so the caller can label honestly.

import type { SearchOptions, SearchResult } from "./search.ts";
import { hasUvx, newsViaDdgs, type DdgsRawRow } from "./ddgs-uv.ts";
import { searchDuckDuckGo } from "./duckduckgo.ts";

// ── Normalization (pure seam) ─────────────────────────────────────────────────

export type DdgsNewsRow = DdgsRawRow;

/** ddgs news rows → SearchResult. Verbatim mapping: title→title, url→url,
 *  body→snippet, date→publishedDate (unmodified), source→author, image dropped.
 *  Rows without a url are dropped. Pure; exported for tests. */
export function normalizeNewsResults(rows: DdgsNewsRow[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const r of rows) {
    if (!r.url) continue;
    results.push({
      title: r.title ?? "",
      url: r.url,
      snippet: r.body ?? "",
      ...(r.date ? { publishedDate: r.date } : {}),
      ...(r.source ? { author: r.source } : {}),
    });
  }
  return results;
}

// ── Degrade notice ────────────────────────────────────────────────────────────

export type NewsDegradeReason = "no-uv" | "ddgs-failed";

/** Append a visible notice to the last result so degraded (text) results are
 *  never mistaken for news results. Same shape as DDG's withDdgsNotice. */
export function withNewsNotice(
  results: SearchResult[],
  reason: NewsDegradeReason,
): SearchResult[] {
  if (results.length === 0) return results;
  const note = reason === "no-uv"
    ? "uvx unavailable — text search used instead; results lack news dates and outlets"
    : "ddgs news failed — text search used instead; results lack news dates and outlets";
  const noted = results.slice();
  const last = noted[noted.length - 1]!;
  noted[noted.length - 1] = { ...last, snippet: `${last.snippet}\n\n[News: ${note}]` };
  return noted;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface NewsOutcome {
  results: SearchResult[];
  degraded: boolean;
  reason?: NewsDegradeReason;
}

/** Injectable seams so the degrade flow is testable without network. */
export interface NewsDeps {
  hasUvx: () => boolean;
  runNews: (query: string, options: SearchOptions) => SearchResult[];
  runText: (query: string, options: SearchOptions) => Promise<SearchResult[]>;
}

export const defaultNewsDeps: NewsDeps = {
  hasUvx,
  runNews: (query, options) => normalizeNewsResults(newsViaDdgs(query, options)),
  runText: searchDuckDuckGo,
};

/** Search the news vertical; degrade to text search (same query, same window)
 *  when the news path is unavailable. Degrade is reported, never silent. */
export async function searchNews(
  query: string,
  options: SearchOptions = {},
  deps: NewsDeps = defaultNewsDeps,
): Promise<NewsOutcome> {
  if (!deps.hasUvx()) {
    return {
      results: withNewsNotice(await deps.runText(query, options), "no-uv"),
      degraded: true,
      reason: "no-uv",
    };
  }
  try {
    return { results: deps.runNews(query, options), degraded: false };
  } catch {
    return {
      results: withNewsNotice(await deps.runText(query, options), "ddgs-failed"),
      degraded: true,
      reason: "ddgs-failed",
    };
  }
}
