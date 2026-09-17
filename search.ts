// search.ts — deep module: provider seam + result normalization + answer synthesis
//
// The SearchProvider seam sits here. Two adapters (DuckDuckGo, Exa MCP) are
// real adapters behind a small interface. Everything the caller needs to know
// is in SearchResponse; everything behind the seam is an implementation detail.

import { searchDuckDuckGo } from "./duckduckgo.ts";
import { searchExaMcp, searchExaAdvanced } from "./exa-mcp.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchProviderName = "duckduckgo" | "exa";

export type ExaCategory =
  | "company"
  | "publication"
  | "news"
  | "personal site"
  | "people"
  | "pdf"
  | "github"
  | "financial report";

export interface SearchOptions {
  numResults?: number;
  recency?: "day" | "week" | "month" | "year";
  domains?: string[];
  category?: ExaCategory;
  includeContent?: boolean;
  includeSummary?: boolean;
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  publishedDate?: string;
  author?: string;
}

export interface SearchResponse {
  answer: string;
  results: SearchResult[];
  provider: SearchProviderName;
}

// ── SearchProvider seam ──────────────────────────────────────────────────────
// Two adapters means a real seam. Each satisfies this contract and does
// provider-specific work (HTML parsing, JSON-RPC, normalization) behind it.

interface SearchProvider {
  search(query: string, options: SearchOptions): Promise<SearchResponse>;
}

const duckduckgoProvider: SearchProvider = {
  async search(query, options) {
    const results = await searchDuckDuckGo(query, options);
    return { answer: buildAnswer(results), results, provider: "duckduckgo" };
  },
};

const exaProvider: SearchProvider = {
  async search(query, options) {
    const results = options.includeContent || options.domains || options.recency || options.category
      ? await searchExaAdvanced(query, options)
      : await searchExaMcp(query, options);
    return { answer: buildAnswer(results), results, provider: "exa" };
  },
};

// ── Intent-aware auto routing ───────────────────────────────────────────────
// The agent expresses intent (category, content, domains); availability is
// runtime state only the tool observes. So auto-routing is a pure function of
// intent: Exa-shaped params that DuckDuckGo cannot honor route straight to
// Exa (no wasted DDG attempt that silently ignores them); plain queries start
// free. Either way the other provider remains the failure fallback.

export type AutoRoute = "ddg-first" | "exa-first";

export function resolveAutoRoute(options: SearchOptions): AutoRoute {
  const exaShaped = options.category !== undefined
    || options.includeContent === true
    || options.includeSummary === true
    || (options.domains !== undefined && options.domains.length > 0);
  return exaShaped ? "exa-first" : "ddg-first";
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  options: SearchOptions & { provider?: SearchProviderName | "auto" },
): Promise<SearchResponse> {
  const requested = options.provider ?? "auto";

  if (requested === "duckduckgo") {
    return duckduckgoProvider.search(query, options);
  }
  if (requested === "exa") {
    return exaProvider.search(query, options);
  }

  // auto: intent decides the order, availability decides the fallback
  const [first, second] = resolveAutoRoute(options) === "exa-first"
    ? [exaProvider, duckduckgoProvider]
    : [duckduckgoProvider, exaProvider];
  try {
    return await first.search(query, options);
  } catch {
    return second.search(query, options);
  }
}

// ── Answer synthesis ─────────────────────────────────────────────────────────
// Pure function. Source-linked, skimmable. The caller never touches individual
// provider quirks — they get { answer, results }.

function buildAnswer(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const parts = results.map((r, i) => {
    const snippet = r.snippet
      ? r.snippet.replace(/\s+/g, " ").trim().slice(0, 500)
      : "";
    const label = r.title || `Source ${i + 1}`;
    if (snippet) return `${snippet}\nSource: ${label} (${r.url})`;
    return `Source: ${label} (${r.url})`;
  });

  return parts.join("\n\n");
}
