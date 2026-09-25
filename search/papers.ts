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
import {
  PaperError,
  paperError,
  buildPaperSnippet,
  parsePaperSeed,
  type PaperCitationGraph,
  type PaperFilters,
  type PaperRecord,
} from "./paper-backend.ts";
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
  /** The works the seed cites — the backward citation walk hydrates these
   *  (the filter API auto-maps referenced_works:W… onto cites:W…, the forward
   *  direction only). */
  referenced_works?: string[];
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

/** The OpenAlex `filter=` value for the search constraints — one comma list
 *  (the API's grammar). Year exact: publication_year:2023; range:
 *  from_publication_date,to_publication_date; OA: is_oa:true; a citation
 *  walk's forward leg adds cites:W…. Verified live. Pure; exported. */
export function buildOpenAlexFilter(filters?: PaperFilters, cites?: string): string {
  const parts: string[] = [];
  if (filters?.year !== undefined) parts.push(`publication_year:${filters.year}`);
  if (filters?.yearRange) {
    parts.push(`from_publication_date:${filters.yearRange[0]}-01-01`);
    parts.push(`to_publication_date:${filters.yearRange[1]}-12-31`);
  }
  if (filters?.openAccess === true) parts.push("is_oa:true");
  if (cites) parts.push(`cites:${cites}`);
  return parts.join(",");
}

/** Backward hydration: the seed record's referenced_works (full openalex.org
 *  URLs) become one OR-list filter. Pure; exported for tests. */
export function buildOpenAlexBackwardFilter(wids: string[]): string {
  return `openalex_id:${wids.map((u) => u.replace(/^https?:\/\/openalex\.org\//, "")).join("|")}`;
}

/** OpenAlex OR-lists cap at 50 values per filter — backward walks hydrate the
 *  seed's references in chunks of this size. */
export const OPENALEX_FILTER_OR_CAP = 50;

/** Build the OpenAlex works query. per-page sized; `mailto` set only when a
 *  contact address exists (never sent empty); `filter` set only when the
 *  caller carries constraints (search or citation walk). `search` is omitted
 *  when the query is empty (a walk has none). Pure; exported for tests. */
export function buildPaperParams(query: string, numResults: number, mailto: string | null, filter = ""): URLSearchParams {
  const params = new URLSearchParams({
    "per-page": String(numResults),
  });
  if (query) params.set("search", query);
  if (filter) params.set("filter", filter);
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
  /** Fetch a single work record by lookup ("doi:10.…" or "W…"); null when
   *  the record is absent. Used by the citation walk's seed resolution. */
  fetchRecord: (lookup: string, signal?: AbortSignal) => Promise<OpenAlexWork | null>;
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
  async fetchRecord(lookup, signal) {
    const url = `https://api.openalex.org/works/${lookup}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.any(
        signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
      ),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`);
    return (await res.json()) as OpenAlexWork;
  },
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

/** Strip the openalex.org URL form from a work id, keeping the bare W-id. */
function bareOpenAlexId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//, "");
}

/** The OpenAlex citation walk (PIWEB-16). Forward: filter=cites:W… on the
 *  works endpoint — the exact param-plan contract, and year/OA constraints
 *  combine server-side in the same filter list. Backward: the works endpoint
 *  has no "works this paper cites" filter (referenced_works:W… auto-maps to
 *  the forward direction, verified live), so the seed record's
 *  referenced_works list hydrates through filter=openalex_id:W…|…, chunked
 *  at the API's 50-value OR cap. DOI seeds resolve through a record fetch
 *  first; PMID/PMCID seeds are Europe PMC's vocabulary — an in-band error
 *  names the other index. */
async function searchOpenAlexWalk(
  graph: PaperCitationGraph,
  n: number,
  options: SearchOptions,
  deps: OpenAlexDeps,
): Promise<PaperRecord[]> {
  const seed = parsePaperSeed(graph.seed);
  if (seed === null) {
    throw new PaperError(paperError("malformed", "openalex", `unreadable seed "${graph.seed}" — pass a DOI, PMID, PMCID, or OpenAlex W-id`));
  }
  if (seed.kind === "pmid" || seed.kind === "pmcid") {
    throw new PaperError(paperError("malformed", "openalex", `seed is a ${seed.kind} id; OpenAlex walks need a DOI or W-id — retry with index: "europepmc"`));
  }
  let wId: string;
  let referenced: string[] | undefined;
  try {
    if (seed.kind === "openalex") {
      wId = bareOpenAlexId(seed.value);
    } else {
      const rec = await deps.fetchRecord(`doi:${seed.value}`, options.signal);
      if (rec === null) {
        throw new PaperError(paperError("no-results", "openalex", `seed DOI "${seed.value}" matched no OpenAlex record`));
      }
      wId = bareOpenAlexId(rec.id ?? "");
      referenced = rec.referenced_works;
    }
    if (graph.direction !== "citedBy") {
      // Forward: one works query, filters combined server-side.
      return await fetchOpenAlexWorks(
        buildPaperParams("", n, readMailto(), buildOpenAlexFilter(options.filters, wId)),
        n,
        options,
        deps,
      );
    }
    // Backward: the seed record's references hydrate through the works list.
    const refs = referenced ?? (await (async () => {
      const rec = await deps.fetchRecord(wId, options.signal);
      return rec?.referenced_works ?? [];
    })());
    if (refs.length === 0) {
      throw new PaperError(paperError("no-results", "openalex"));
    }
    const records: PaperRecord[] = [];
    for (let i = 0; i < refs.length; i += OPENALEX_FILTER_OR_CAP) {
      const chunk = refs.slice(i, i + OPENALEX_FILTER_OR_CAP);
      const page = await fetchOpenAlexWorks(
        buildPaperParams("", n, readMailto(), buildOpenAlexBackwardFilter(chunk)),
        n,
        options,
        deps,
      );
      records.push(...page);
      if (records.length >= n) break;
    }
    if (records.length === 0) {
      throw new PaperError(paperError("no-results", "openalex"));
    }
    return records.slice(0, n);
  } catch (err) {
    if (err instanceof PaperError) throw err;
    throw new PaperError(paperError("backend-down", "openalex", err instanceof Error ? err.message : String(err)));
  }
}

/** One works-list fetch → normalized records; failure shaped as the contract
 *  error. Shared by the search and walk paths. */
async function fetchOpenAlexWorks(
  params: URLSearchParams,
  n: number,
  options: SearchOptions,
  deps: OpenAlexDeps,
): Promise<PaperRecord[]> {
  let works: OpenAlexWork[];
  try {
    works = await deps.fetchWorks(params, options.signal);
  } catch (err) {
    throw new PaperError(paperError("backend-down", "openalex", err instanceof Error ? err.message : String(err)));
  }
  const results = normalizePaperResults(works);
  if (results.length === 0) {
    throw new PaperError(paperError("no-results", "openalex"));
  }
  return results.slice(0, n);
}

/** The OpenAlex backend call: params → normalized records, failure shaped as
 *  the contract error. Backend-specific import; the shared dispatch lives in
 *  searchPapers. */
async function searchOpenAlex(
  query: string,
  options: SearchOptions,
  deps: OpenAlexDeps,
): Promise<PaperRecord[]> {
  const n = options.numResults ?? DEFAULT_PAGE_SIZE;
  const graph = options.filters?.citationGraph;
  if (graph) return searchOpenAlexWalk(graph, n, options, deps);
  return fetchOpenAlexWorks(buildPaperParams(query, n, readMailto(), buildOpenAlexFilter(options.filters)), n, options, deps);
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
