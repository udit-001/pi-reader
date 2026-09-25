// papers.ts — the papers vertical dispatcher: `provider: "papers"`.
// Explicit-only: never chosen by auto-routing — searching the scholarly
// record is a deliberate dispatch, not an intent the router guesses — so this
// adapter lives outside the auto chain and is dispatched only when the agent
// names it.
//
// Two backends behind one call (PIWEB-14 OpenAlex, PIWEB-15 Europe PMC),
// selected with `index` (default "openalex"):
//   openalex  — OpenAlex: open scholarly metadata across all disciplines,
//               ~250M works, no key, `mailto` politeness param.
//   europepmc — Europe PMC: biomedical full text — PubMed abstracts, PMC
//               copies, preprints, patents; the DOI, PMC URL, and OA tag
//               reach the agent, not just the abstract page.
// Both normalize into the same PaperRecord shape (search/paper-backend.ts:
// year, authors, venue, citedBy, oaUrl, doi flat keys beside the standard
// title/url/snippet) — no per-backend forking downstream.
//
// Failure is in-band, never degrade-to-text: prose cannot substitute for
// paper records, so every failure throws PaperError with the contract
// grammar (named backend, no-results/backend-down/malformed distinction,
// retry `index`, manual-URL escape hatch) and the entry passes it verbatim.

import type { SearchOptions, PaperIndexName } from "./search.ts";
import { PaperError, paperError, buildPaperSnippet, type PaperRecord } from "./paper-backend.ts";
import { searchEuropePmc, defaultEuropePmcDeps, type EuropePmcDeps } from "./europepmc.ts";
import { loadConfig } from "../config.ts";

const TIMEOUT_MS = 25_000;
const DEFAULT_PAGE_SIZE = 10;
/** The dispatch vocabulary — the schema's `index` literals and the runtime
 *  guard read this one array. */
export const PAPER_INDEXES: readonly PaperIndexName[] = ["openalex", "europepmc"];

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

// ── Pure seams (OpenAlex): DOI parse, URL choice, OA URL choice ──────────────

/** OpenAlex carries the DOI as an https URL ("https://doi.org/10.1038/…");
 *  agents expect the bare identifier ("10.1038/…"). Absent or not a doi.org
 *  URL → null. Pure; exported for tests. */
export function parseDoi(doiUrl: string | undefined): string | null {
  if (doiUrl === undefined) return null;
  const m = doiUrl.match(/^https?:\/\/doi\.org\/(.+)$/i);
  return m?.[1] ?? null;
}

/** `url` — the canonical place the agent acts on: the DOI when present
 *  (stable, resolvable), else the primary landing page, else the OpenAlex
 *  record URL. Pure; exported for tests. */
export function chooseRecordUrl(w: OpenAlexWork): string | null {
  if (w.doi) return w.doi;
  if (w.primary_location?.landing_page_url) return w.primary_location.landing_page_url;
  if (typeof w.id === "string" && w.id) return w.id;
  return null;
}

/** `oaUrl` — the best reachable full text: best_oa_location's PDF, then its
 *  landing page, then the top-level oa_url. Absent (null) when closed. Pure;
 *  exported for tests. */
export function chooseOaUrl(w: OpenAlexWork): string | null {
  if (w.best_oa_location?.pdf_url) return w.best_oa_location.pdf_url;
  if (w.best_oa_location?.landing_page_url) return w.best_oa_location.landing_page_url;
  const oaUrl = w.open_access?.oa_url;
  return typeof oaUrl === "string" && oaUrl ? oaUrl : null;
}

// ── Pure seam: normalization (agent-POV, OpenAlex) ────────────────────────────

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
    const authors = (w.authorships ?? [])
      .map((a) => a.author?.display_name)
      .filter((n): n is string => typeof n === "string");
    const rec: PaperRecord = {
      title: w.title ?? "",
      url,
      snippet: buildPaperSnippet({
        venue: w.primary_location?.source?.display_name,
        year: w.publication_year,
        citedBy: w.cited_by_count,
        authors,
        oaToken: w.open_access
          ? w.open_access.oa_status ?? (w.open_access.is_oa ? "open" : "closed")
          : undefined,
      }),
    };
    if (w.publication_year !== undefined) rec.year = w.publication_year;
    if (authors.length > 0) rec.authors = authors;
    const venue = w.primary_location?.source?.display_name;
    if (venue) rec.venue = venue;
    if (w.cited_by_count !== undefined) rec.citedBy = w.cited_by_count;
    const oaUrl = chooseOaUrl(w);
    if (oaUrl) rec.oaUrl = oaUrl;
    const doi = parseDoi(w.doi);
    if (doi) rec.doi = doi;
    records.push(rec);
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

// ── Adapter (OpenAlex) ───────────────────────────────────────────────────────

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

/** The OpenAlex backend call: params → normalized records, failure shaped as
 *  the contract error. Backend-specific import; the shared dispatch lives in
 *  searchPapers. */
async function searchOpenAlex(
  query: string,
  options: SearchOptions,
  deps: OpenAlexDeps,
): Promise<PaperRecord[]> {
  const n = options.numResults ?? DEFAULT_PAGE_SIZE;
  const params = buildPaperParams(query, n, readMailto());
  let works: OpenAlexWork[];
  try {
    works = await deps.fetchWorks(params, options.signal);
  } catch (err) {
    throw new PaperError(
      paperError("backend-down", "openalex", err instanceof Error ? err.message : String(err)),
    );
  }
  const results = normalizePaperResults(works);
  if (results.length === 0) {
    throw new PaperError(paperError("no-results", "openalex"));
  }
  return results.slice(0, n);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Search the papers vertical. `index` selects the backend ("openalex"
 *  default, "europepmc" for biomedical full text). Throws PaperError whose
 *  message IS the in-band error text — named backend, retry hint, status
 *  distinction — so the entry passes it through verbatim. */
export async function searchPapers(
  query: string,
  options: SearchOptions = {},
  deps: { openalex?: OpenAlexDeps; europepmc?: EuropePmcDeps } = {},
): Promise<PaperRecord[]> {
  const requested = (options.index ?? "openalex") as PaperIndexName;
  const index = PAPER_INDEXES.includes(requested)
    ? requested
    : "openalex";
  return index === "europepmc"
    ? searchEuropePmc(query, options, deps.europepmc ?? defaultEuropePmcDeps)
    : searchOpenAlex(query, options, deps.openalex ?? defaultOpenAlexDeps);
}
