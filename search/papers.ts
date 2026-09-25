// papers.ts — the papers vertical adapter: `provider: "papers"`, backed by
// OpenAlex (open scholarly metadata, no key, ~250M works). Explicit-only:
// never chosen by auto-routing — searching the scholarly record is a
// deliberate dispatch, not an intent the router guesses — so this adapter
// lives outside the auto chain and is dispatched only when the agent names it.
//
// The single high seam is `searchPapers(query, options)`. The second backend
// (Europe PMC, PIWEB-15) joins by extending the backend dispatch; the record
// shape produced here — `year`, `authors`, `venue`, `citedBy`, `oaUrl`, `doi`
// flat keys beside the standard title/url/snippet — is the contract every
// backend must normalize into.
//
// The OpenAlex `mailto` politeness param is config-read and absent-tolerant
// by contract: the call works without it, OpenAlex's fair-use rate limits
// just bite sooner.
//
// No degrade-to-text: prose snippets cannot substitute for paper records, so
// failure surfaces as an in-band error naming the cause (PIWEB-15 completes
// the error contract with the retry `index` hint).

import type { SearchOptions, SearchResult } from "./search.ts";
import { loadConfig } from "../config.ts";

const TIMEOUT_MS = 25_000;
const DEFAULT_PAGE_SIZE = 10;

// ── Raw shape (OpenAlex work — trimmed live capture 2026-09-25) ───────────────
// Only the fields normalization reads are named; the rest (topics, mesh,
// funders, counts_by_year, …) are dropped no-ops — nothing the agent does with
// a paper needs them.

export interface OpenAlexWork {
  /** OpenAlex ID, e.g. "https://openalex.org/W3161425918". */
  id?: string;
  /** URL form, e.g. "https://doi.org/10.1038/s41587-020-0561-9". */
  doi?: string;
  title?: string;
  publication_year?: number;
  cited_by_count?: number;
  primary_location?: {
    landing_page_url?: string;
    source?: { display_name?: string } | null;
  } | null;
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null } | null;
  best_oa_location?: { landing_page_url?: string; pdf_url?: string | null } | null;
  authorships?: Array<{ author?: { display_name?: string } | null }>;
  [key: string]: unknown;
}

// ── PaperRecord — the record shape (the seam's result contract) ──────────────

/** Paper keys ride on the standard SearchResult as flat extra keys — the agent
 *  (and PIWEB-16's citation traversal) reads them without a new result
 *  taxonomy. Absent when the API doesn't provide the field; never invented. */
export interface PaperRecord extends SearchResult {
  /** Publication year. */
  year?: number;
  /** Author display names, in the API's order. */
  authors?: string[];
  /** Hosting venue — journal, repository, or preprint server. */
  venue?: string;
  /** Total citation count. */
  citedBy?: number;
  /** Best reachable open-access URL; absent when the work is closed. */
  oaUrl?: string;
  /** Bare DOI identifier ("10.1038/s41587-020-0561-9"), not the URL form. */
  doi?: string;
}

/** Structural probe: does this result carry the flat paper keys? Used by the
 *  entry to render paper fields on generic SearchResult rows. Pure; exported
 *  for tests. */
export function isPaperRecord(r: SearchResult): r is PaperRecord {
  return "year" in r || "venue" in r || "citedBy" in r || "oaUrl" in r || "doi" in r
    || Array.isArray((r as PaperRecord).authors);
}

// ── Pure seam: DOI parse ─────────────────────────────────────────────────────

/** OpenAlex carries the DOI as an https URL ("https://doi.org/10.1038/…");
 *  agents expect the bare identifier ("10.1038/…"). Absent or not a doi.org
 *  URL → null. Pure; exported for tests. */
export function parseDoi(doiUrl: string | undefined): string | null {
  if (doiUrl === undefined) return null;
  const m = doiUrl.match(/^https?:\/\/doi\.org\/(.+)$/i);
  return m?.[1] ?? null;
}

// ── Pure seam: URL choice ────────────────────────────────────────────────────

/** `url` — the canonical place the agent acts on: the DOI when present
 *  (stable, resolvable), else the primary landing page, else the OpenAlex
 *  record URL. Pure; exported for tests. */
export function chooseRecordUrl(w: OpenAlexWork): string | null {
  if (w.doi) return w.doi;
  if (w.primary_location?.landing_page_url) return w.primary_location.landing_page_url;
  if (typeof w.id === "string" && w.id) return w.id;
  return null;
}

// ── Pure seam: OA URL choice ─────────────────────────────────────────────────

/** `oaUrl` — the best reachable full text: best_oa_location's PDF, then its
 *  landing page, then the top-level oa_url. Absent (null) when closed. Pure;
 *  exported for tests. */
export function chooseOaUrl(w: OpenAlexWork): string | null {
  if (w.best_oa_location?.pdf_url) return w.best_oa_location.pdf_url;
  if (w.best_oa_location?.landing_page_url) return w.best_oa_location.landing_page_url;
  const oaUrl = w.open_access?.oa_url;
  return typeof oaUrl === "string" && oaUrl ? oaUrl : null;
}

// ── Pure seam: snippet ────────────────────────────────────────────────────────

/** The agent skims a papers hit the way it skims a video token —
 *    "Nature Biotechnology · 2020 · 2387 citations · closed · Anzalone et al."
 *  Tokens join with " · "; missing fields tolerated (no invented tokens).
 *  Pure; exported for tests. */
export function buildPaperSnippet(w: OpenAlexWork): string {
  const tokens: string[] = [];
  const venue = w.primary_location?.source?.display_name;
  if (venue) tokens.push(venue);
  if (w.publication_year !== undefined) tokens.push(String(w.publication_year));
  if (w.cited_by_count !== undefined) tokens.push(`${w.cited_by_count} citations`);
  if (w.open_access) tokens.push(w.open_access.oa_status ?? (w.open_access.is_oa ? "open" : "closed"));
  const authors = (w.authorships ?? [])
    .map((a) => a.author?.display_name)
    .filter((n): n is string => typeof n === "string");
  const first = authors[0];
  if (first !== undefined) tokens.push(authors.length === 1 ? first : `${first} et al.`);
  return tokens.join(" · ");
}

// ── Pure seam: normalization (agent-POV) ──────────────────────────────────────

/** OpenAlex works → PaperRecords. year←publication_year, authors←authorships
 *  display names, venue←primary_location.source.display_name,
 *  citedBy←cited_by_count, oaUrl←chooseOaUrl (absent when closed), doi←
 *  parseDoi, url←chooseRecordUrl. Works with no record URL are dropped — no
 *  url, no action. Pure; exported for tests. */
export function normalizePaperResults(works: OpenAlexWork[]): PaperRecord[] {
  const records: PaperRecord[] = [];
  for (const w of works) {
    const url = chooseRecordUrl(w);
    if (url === null) continue;
    const r: PaperRecord = {
      title: w.title ?? "",
      url,
      snippet: buildPaperSnippet(w),
    };
    if (w.publication_year !== undefined) r.year = w.publication_year;
    const authors = (w.authorships ?? [])
      .map((a) => a.author?.display_name)
      .filter((n): n is string => typeof n === "string");
    if (authors.length > 0) r.authors = authors;
    const venue = w.primary_location?.source?.display_name;
    if (venue) r.venue = venue;
    if (w.cited_by_count !== undefined) r.citedBy = w.cited_by_count;
    const oaUrl = chooseOaUrl(w);
    if (oaUrl) r.oaUrl = oaUrl;
    const doi = parseDoi(w.doi);
    if (doi) r.doi = doi;
    records.push(r);
  }
  return records;
}

// ── Pure seam: request params ────────────────────────────────────────────────

/** Build the OpenAlex works query. per-page sized; `mailto` set only when a
 *  contact address exists (never sent empty). Filters (year window,
 *  open-access-only) are PIWEB-16 — no filter params pre-adopted. Pure;
 *  exported for tests. */
export function buildPaperParams(query: string, numResults: number, mailto: string | null): URLSearchParams {
  const params = new URLSearchParams({
    search: query,
    "per-page": String(numResults),
  });
  if (mailto) params.set("mailto", mailto);
  return params;
}

// ── Politeness param — config-read, absent-tolerant ─────────────────────────

/** The OpenAlex contact address, when configured; null when absent or blank —
 *  the call must work without it. config.ts owns the read; tests inject the
 *  address via deps instead of touching this. */
function readMailto(): string | null {
  const mailto = loadConfig()?.papers?.openalexEmail?.trim();
  return mailto ? mailto : null;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface OpenAlexDeps {
  /** Fetch the works endpoint with these params; return the results array. */
  fetchWorks: (params: URLSearchParams, signal?: AbortSignal) => Promise<OpenAlexWork[]>;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any(
      signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
    ),
  });
  if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`);
  return res.json() as unknown;
}

export const defaultOpenAlexDeps: OpenAlexDeps = {
  async fetchWorks(params, signal) {
    const url = `https://api.openalex.org/works?${params}`;
    const body = await fetchJson(url, signal);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("OpenAlex response is not an object");
    }
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new Error("OpenAlex response has no results array");
    }
    return results as OpenAlexWork[];
  },
};

/** Search the papers vertical (OpenAlex backend). Throws when the backend is
 *  unavailable or the query yields nothing parseable — the entry surfaces the
 *  error as an actionable in-band message instead of fake results. */
export async function searchPapers(
  query: string,
  options: SearchOptions = {},
  deps: OpenAlexDeps = defaultOpenAlexDeps,
): Promise<PaperRecord[]> {
  const params = buildPaperParams(query, options.numResults ?? DEFAULT_PAGE_SIZE, readMailto());
  let works: OpenAlexWork[];
  try {
    works = await deps.fetchWorks(params, options.signal);
  } catch (err) {
    throw new Error(
      `OpenAlex paper search failed (${err instanceof Error ? err.message : String(err)}). ` +
      "Workaround: retry later or use a general provider (e.g. Exa with category: 'publication')",
    );
  }
  const results = normalizePaperResults(works);
  if (results.length === 0) {
    throw new Error("OpenAlex search returned no parseable paper records");
  }
  return results.slice(0, options.numResults ?? DEFAULT_PAGE_SIZE);
}
