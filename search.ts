// search.ts — deep module: provider seam + result normalization + answer synthesis
//
// The SearchProvider seam sits here. Multiple adapters are real adapters
// behind a small interface. Everything the caller needs to know is in
// SearchResponse; everything behind the seam is an implementation detail.

import { searchDuckDuckGo } from "./duckduckgo.ts";
import { searchExaMcp, searchExaAdvanced } from "./exa-mcp.ts";
import { searchGrepCode } from "./grep-mcp.ts";
import { webSearch as searchFreeProviders } from "./search-providers.ts";
import * as cache from "./cache.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchProviderName = "duckduckgo" | "exa" | "wikipedia" | "hn" | "context7" | "grep";

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
  /** Code-search filters — used by provider "grep". */
  repo?: string;
  path?: string;
  language?: string[];
  regexp?: boolean;
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

// Free providers: Wikipedia, HN, Context7 (no API key needed)
// Used as fallback when DDG and Exa both fail.
// grep: explicit-only (curated GitHub index — never auto-routed; Exa keeps
// the broad code case).
const grepProvider: SearchProvider = {
  async search(query, options) {
    const results = await searchGrepCode({
      query,
      repo: options.repo,
      path: options.path,
      language: options.language,
      useRegexp: options.regexp,
      signal: options.signal,
    });
    return { answer: buildAnswer(results), results, provider: "grep" };
  },
};

const freeProviders: SearchProvider = {
  async search(query, options) {
    // Determine source from options or default to auto
    const source = (options as any).source ?? "auto";
    const outcome = await searchFreeProviders(query, source, options.signal);
    const results = outcome.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet ?? "",
    }));
    return { answer: buildAnswer(results), results, provider: source === "auto" ? "duckduckgo" : source };
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

// ── Search cache ────────────────────────────────────────────────────────────
// Cache search results to avoid re-fetching and to survive DDG captcha.

const SEARCH_CACHE_DIR = join(homedir(), ".pi", "agent", "pi-reader-cache", "search");
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedSearch {
  query: string;
  provider: string;
  results: SearchResult[];
  timestamp: number;
}

function getSearchCacheKey(query: string, options: SearchOptions & { provider?: SearchProviderName | "auto" }): string {
  // Hash query + options to create a unique cache key
  const parts = [
    query,
    options.provider ?? "auto",
    options.category ?? "",
    options.recency ?? "",
    (options.domains ?? []).sort().join(","),
    String(options.includeContent ?? false),
    String(options.includeSummary ?? false),
    // code-search filters (provider "grep") — filtered and unfiltered
    // searches over the same query are different results
    options.repo ?? "",
    options.path ?? "",
    (options.language ?? []).sort().join(","),
    String(options.regexp ?? false),
  ];
  // Simple hash
  let hash = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      hash = ((hash << 5) - hash + p.charCodeAt(i)) | 0;
    }
  }
  return `search-${Math.abs(hash).toString(36)}`;
}

function readSearchCache(key: string): CachedSearch | null {
  try {
    const path = join(SEARCH_CACHE_DIR, `${key}.json`);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as CachedSearch;
    if (Date.now() - data.timestamp > SEARCH_CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSearchCache(key: string, data: CachedSearch): void {
  try {
    mkdirSync(SEARCH_CACHE_DIR, { recursive: true });
    const path = join(SEARCH_CACHE_DIR, `${key}.json`);
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {
    // Cache write failed — not critical
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  options: SearchOptions & { provider?: SearchProviderName | "auto" },
): Promise<SearchResponse> {
  const requested = options.provider ?? "auto";

  // Check cache first (unless provider is explicitly set to exa)
  if (requested !== "exa") {
    const cacheKey = getSearchCacheKey(query, options);
    const cached = readSearchCache(cacheKey);
    if (cached) {
      return { answer: buildAnswer(cached.results), results: cached.results, provider: cached.provider as SearchProviderName };
    }
  }

  let response: SearchResponse;

  // Explicit provider selection — agent knows which one to use
  if (requested === "duckduckgo") {
    response = await duckduckgoProvider.search(query, options);
  } else if (requested === "exa") {
    response = await exaProvider.search(query, options);
  } else if (requested === "wikipedia" || requested === "hn" || requested === "context7") {
    // Domain-specific providers — only when explicitly requested
    response = await freeProviders.search(query, { ...options, source: requested } as any);
  } else if (requested === "grep") {
    // Code search — explicit-only, never in the auto-fallback chain
    response = await grepProvider.search(query, options);
  } else {
    // auto: DDG first, Exa fallback. No domain-specific fallback.
    const [first, second] = resolveAutoRoute(options) === "exa-first"
      ? [exaProvider, duckduckgoProvider]
      : [duckduckgoProvider, exaProvider];
    try {
      response = await first.search(query, options);
    } catch {
      response = await second.search(query, options);
    }
  }

  // Cache successful results (except Exa which costs money)
  if (response.results.length > 0 && response.provider !== "exa") {
    const cacheKey = getSearchCacheKey(query, options);
    writeSearchCache(cacheKey, {
      query,
      provider: response.provider,
      results: response.results,
      timestamp: Date.now(),
    });
  }

  return response;
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
