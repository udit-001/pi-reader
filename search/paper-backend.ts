// paper-backend.ts — the shared record seam for the papers vertical.
//
// With two real backends (OpenAlex, Europe PMC via `search/`) the flat record
// shape, the display snippet, and the in-band error contract live in a module
// neither backend owns — otherwise one backend's quirks leak into the other's
// output and every row reads a different grammar downstream. Every backend
// normalizes into `PaperRecord` (PIWEB-14's contract, unchanged), renders
// through `buildPaperSnippet`, and reports failure through `paperError` —
// named backend, retry `index`, manual-URL escape hatch, and the
// no-results/backend-down/malformed distinction.
//
// No degrade-to-text anywhere in the vertical: prose cannot substitute for
// paper records, so failure always fails in-band, never fakes rows.

import type { SearchResult, PaperIndexName } from "./search.ts";

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

/** Every backend paged at the same size; the entry's default (10/15) and
 *  tests all agree on the width. */
export const DEFAULT_PAGE_SIZE = 10;

// ── Pure seam: snippet ────────────────────────────────────────────────────────

/** The per-record snippet inputs, whatever backend produced them. Each field
 *  absent tolerated — the builder never invents a token. */
export interface PaperSnippetMeta {
  venue?: string;
  year?: number;
  citedBy?: number;
  /** Author display names, in the API's order; only the first (plus count)
   *  reaches the snippet. */
  authors?: string[];
  /** Open-access badge the backend already classified ("closed", "green",
   *  "open"); absent → no token. */
  oaToken?: string;
}

/** The agent skims a papers hit the way it skims a video token —
 *    "Nature Biotechnology · 2020 · 2387 citations · closed · Anzalone et al."
 *  Tokens join with " · "; missing fields tolerated (no invented tokens).
 *  Shared by every backend — one snippet shape, wherever the record came
 *  from. Pure; exported for tests. */
export function buildPaperSnippet(meta: PaperSnippetMeta): string {
  const tokens: string[] = [];
  if (meta.venue) tokens.push(meta.venue);
  if (meta.year !== undefined) tokens.push(String(meta.year));
  if (meta.citedBy !== undefined) tokens.push(`${meta.citedBy} citations`);
  if (meta.oaToken) tokens.push(meta.oaToken);
  const first = meta.authors?.[0];
  if (first !== undefined) {
    tokens.push((meta.authors?.length ?? 1) === 1 ? first : `${first} et al.`);
  }
  return tokens.join(" · ");
}

// ── Filters + citation traversal (PIWEB-16) ───────────────────────────────

/** Constrain a papers search, or turn it into a citation walk. Shared across
 *  backends so PIWEB-15's same-shape normalizers stay the only fork point. */
export interface PaperFilters {
  /** Exact publication year. */
  year?: number;
  /** Inclusive [from, to] publication years — the tool schema enforces
   *  exactly two integer items (a TypeBox tuple emits draft-07 positional
   *  `items`, which 2020-12 validators reject). */
  yearRange?: number[];
  /** Restrict to open-access-readable results. */
  openAccess?: boolean;
  /** Turn the search into a graph walk from a seed paper: "cites" (default)
 *  walks forward — works citing the seed; "citedBy" walks backward — the
 *  seed's own references. The walk replaces the free-text query. */
  citationGraph?: PaperCitationGraph;
}

export interface PaperCitationGraph {
  seed: string;
  direction?: "cites" | "citedBy";
}

export type PaperSeed =
  | { kind: "doi"; value: string }
  | { kind: "pmid"; value: string }
  | { kind: "pmcid"; value: string }
  | { kind: "openalex"; value: string };

/** The seed a citation walk starts from — whatever the agent already holds
 *  from a prior papers row or a paper page: bare DOI, PMID, PMCID, or an
 *  OpenAlex W-id (bare or URL form). Unrecognizable → null; never guessed.
 *  Pure; exported for tests. */
export function parsePaperSeed(seed: string): PaperSeed | null {
  const s = seed.trim();
  if (s === "") return null;
  const doi = s.match(/^(?:https?:\/\/doi\.org\/)?(10\.\d{4,}\S+)$/);
  if (doi) return { kind: "doi", value: doi[1]! };
  const medUrl = s.match(/^https?:\/\/europepmc\.org\/article\/MED\/(\d+)$/);
  if (medUrl) return { kind: "pmid", value: medUrl[1]! };
  const pmcid = s.match(/^(?:https?:\/\/)?(?:europepmc\.org\/article\/)?(?:www\.ncbi\.nlm\.nih\.gov\/pmc\/articles\/)?(PMC\d+)$/i);
  if (pmcid) return { kind: "pmcid", value: pmcid[1]!.toUpperCase() };
  const oa = s.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  if (oa) return { kind: "openalex", value: oa[1]! };
  if (/^\d+$/.test(s)) return { kind: "pmid", value: s };
  return null;
}

/** Year constraints on citation-walk results: Europe PMC's walk endpoints
 *  take no filter params (the documented approximation), so the constraint
 *  applies to the normalized records. A record whose year is unknown can't
 *  be verified — dropped rather than smuggled past the filter. Pure;
 *  exported for tests. */
export function applyYearFilter(records: PaperRecord[], filters?: PaperFilters): PaperRecord[] {
  const year = filters?.year;
  const range = filters?.yearRange;
  if (year === undefined && range === undefined) return records;
  return records.filter((r) => {
    if (r.year === undefined) return false;
    if (year !== undefined && r.year !== year) return false;
    if (range?.[0] !== undefined && range[1] !== undefined
      && (r.year < range[0] || r.year > range[1])) return false;
    return true;
  });
}

/** Stable serialization for the search-cache key — filters change results, so
 *  they ride the key; but key order must not. An all-empty filter object
 *  serializes like no filters at all. Pure; exported for tests. */
export function filtersCacheKey(f?: PaperFilters): string {
  if (!f) return "";
  const parts = [
    f.year ?? "",
    f.yearRange?.[0] ?? "",
    f.yearRange?.[1] ?? "",
    f.openAccess === true ? "y" : "",
    f.citationGraph?.seed ?? "",
    f.citationGraph?.direction ?? "",
  ];
  return parts.some((p) => p !== "") ? parts.join("|") : "";
}

// ── In-band error contract ───────────────────────────────────────────────────

export type PaperBackendStatus = "no-results" | "backend-down" | "malformed";

/** What each index's search actually covers — the error guidance names the
 *  OTHER index with this scope line, so the agent can judge whether the retry
 *  fits its query instead of blind-retrying. */
const INDEX_SCOPE: Record<PaperIndexName, string> = {
  openalex: `index: "openalex" (open scholarly metadata across all disciplines)`,
  europepmc: `index: "europepmc" (biomedical full text: PubMed, preprints, patents)`,
};

/** `otherIndex` — the fallback `index` value the agent is told to try. Pure;
 *  exported for tests. */
export function otherIndex(index: PaperIndexName): PaperIndexName {
  return index === "openalex" ? "europepmc" : "openalex";
}

/** Build the in-band error for a failed papers search. One single home per
 *  meaning: every papers failure reads through this template, so the agent
 *  always sees the same error grammar — backend named, cause distinguished
 *  (no-results vs backend-down vs malformed), retry `index` and manual URL
 *  named. Pure; exported for tests. */
export function paperError(
  status: PaperBackendStatus,
  failedIndex: PaperIndexName,
  detail = "",
): string {
  const backend = failedIndex === "openalex" ? "OpenAlex" : "Europe PMC";
  const cause = detail ? ` (${detail})` : "";
  const retry = INDEX_SCOPE[otherIndex(failedIndex)];
  switch (status) {
    case "malformed":
      return `${backend} rejected the query as malformed${cause}. ` +
        `Retry with ${retry}; simplify the query — drop quotes, brackets, and boolean operators the backend's query parser may not accept.`;
    case "backend-down":
      return `${backend} was unreachable${cause}. ` +
        `Retry with ${retry}, or fetch a specific paper directly if you already hold its DOI or URL.`;
    case "no-results":
      return `${backend} returned no results for this query. ` +
        `Retry with ${retry}, rephrase the query, or fetch a specific paper directly if you already hold its DOI or URL.`;
  }
}

/** The thrown shape so the entry can pass the message through verbatim —
 *  a generic hint rewriter would strip the named backend and the retry
 *  `index`, which IS the actionability. */
export class PaperError extends Error {}
