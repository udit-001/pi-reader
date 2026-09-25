// papers.ts — the papers vertical dispatcher: `provider: "papers"`.
// Explicit-only: never chosen by auto-routing — searching the scholarly
// record is a deliberate dispatch, not an intent the router guesses — so this
// adapter lives outside the auto chain and is dispatched only when the agent
// names it.
//
// Two backends behind one call (PIWEB-14 OpenAlex, PIWEB-15 Europe PMC),
// selected with `index` (default "openalex"):
//   openalex  — OpenAlex: open scholarly metadata across all disciplines,
//               ~250M works, optional free key sent as `api_key=` (the
//               mailto politeness param is retired).
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
  chooseFetchableUrl,
  parsePaperSeed,
  type PaperCitationGraph,
  type PaperFilters,
  type PaperRecord,
} from "./paper-backend.ts";
import { searchEuropePmc, searchEuropePmcLookup, defaultEuropePmcDeps, type EuropePmcDeps } from "./europepmc.ts";
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

/** The shared `select=` projection — exactly the fields normalization reads
 *  plus the enrichment fields. One list for every works-list call: the API
 *  charges per request, so full-record payloads (4.5× larger) are pure
 *  waste. Verified live: nested keys (open_access, primary_topic, …)
 *  project fine. The DOI-seed record fetch is a free singleton and stays
 *  unprojected. Pure; exported. */
export const OPENALEX_SELECT = "id,doi,title,publication_year,cited_by_count,is_retracted,type,open_access,best_oa_location,primary_location,authorships,locations,primary_topic,ids";

export interface OpenAlexWork {
  /** OpenAlex ID, e.g. "https://openalex.org/W3161425918". */
  id?: string;
  /** URL form, e.g. "https://doi.org/10.1038/s41587-020-0561-9". Null on
   *  works without a DOI — OpenAlex sends an explicit null, not a missing key. */
  doi?: string | null;
  title?: string;
  publication_year?: number;
  cited_by_count?: number;
  /** Retraction flag — null when the index doesn't know, false when clean. */
  is_retracted?: boolean | null;
  /** Work type — article, book-chapter, dataset, preprint, …. */
  type?: string | null;
  /** Primary topic — the work's discipline, display_name is the token. */
  primary_topic?: { display_name?: string | null } | null;
  primary_location?: {
    landing_page_url?: string;
    source?: { display_name?: string } | null;
  } | null;
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null } | null;
  best_oa_location?: { landing_page_url?: string; pdf_url?: string | null } | null;
  /** Every copy the work has a record of: publisher, PMC, DOAJ, repositories.
   *  Landing pages here are the raw record URL — most are doi.org forms, but
 *  the PMC/DOAJ/repo copies are not, and they are what fetches cleanly. */
  locations?: Array<{ landing_page_url?: string | null } | null> | null;
  authorships?: Array<{ author?: { display_name?: string } | null }>;
  [key: string]: unknown;
}

// ── Pure seams (OpenAlex): DOI parse, URL choice, OA URL choice ──────────────

/** OpenAlex carries the DOI as an https URL ("https://doi.org/10.1038/…");
 *  agents expect the bare identifier ("10.1038/…"). Works without a DOI come
 *  back as an explicit null (not a missing key), so both are tolerated.
 *  Absent, null, or not a doi.org URL → null. Pure; exported for tests. */
export function parseDoi(doiUrl: string | null | undefined): string | null {
  if (typeof doiUrl !== "string") return null;
  const m = doiUrl.match(/^https?:\/\/doi\.org\/(.+)$/i);
  return m?.[1] ?? null;
}

/** `url` — the canonical place the agent acts on: the most fetchable copy the
 *  work carries, ranked by the shared policy (chooseFetchableUrl in
 *  paper-backend.ts). Candidates in backend preference order: every
 *  location's landing page, then the primary landing, then the best-OA
 *  landing, then the DOI. Pure; exported for tests. */
export function chooseRecordUrl(w: OpenAlexWork): string | null {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === "string" && u && !seen.has(u)) {
      seen.add(u);
      candidates.push(u);
    }
  };
  for (const l of w.locations ?? []) push(l?.landing_page_url);
  push(w.primary_location?.landing_page_url);
  push(w.best_oa_location?.landing_page_url);
  push(w.doi);
  push(w.id);
  return chooseFetchableUrl(candidates);
}

/** `oaUrl` — the best reachable full text, through the same fetchability
 *  policy: best_oa_location's PDF, then its landing page, then the top-level
 *  oa_url. Absent (null) when closed. Pure; exported for tests. */
export function chooseOaUrl(w: OpenAlexWork): string | null {
  return chooseFetchableUrl([
    w.best_oa_location?.pdf_url,
    w.best_oa_location?.landing_page_url,
    w.open_access?.oa_url,
  ]);
}

// ── Pure seam: normalization (agent-POV, OpenAlex) ────────────────────────────

/** OpenAlex works → PaperRecords. year←publication_year, authors←authorships
 *  display names, venue←primary_location.source.display_name,
 *  citedBy←cited_by_count, oaUrl←chooseOaUrl (absent when closed), doi←
 *  parseDoi, url←chooseRecordUrl, retracted←is_retracted, topic←
 *  primary_topic.display_name, type←type — the enrichment keys absent-
 *  tolerant, never invented. Works with no record URL are dropped — no
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
        retracted: w.is_retracted === true ? true : undefined,
        oaToken: w.open_access
          ? w.open_access.oa_status ?? (w.open_access.is_oa ? "open" : "closed")
          : undefined,
        topic: typeof w.primary_topic?.display_name === "string" ? w.primary_topic.display_name : undefined,
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
    if (typeof w.is_retracted === "boolean") rec.retracted = w.is_retracted;
    if (typeof w.type === "string" && w.type) rec.type = w.type;
    const topic = w.primary_topic?.display_name;
    if (typeof topic === "string" && topic) rec.topic = topic;
    records.push(rec);
  }
  return records;
}

// ── Pure seam: request params ────────────────────────────────────────────────

/** The OpenAlex `filter=` value for the search constraints — one comma list
 *  (the API's grammar). Year exact: publication_year:2023; range:
 *  from_publication_date,to_publication_date; OA: is_oa:true; a citation
 *  walk's leg adds cites:{W} (forward) or cited_by:{W} (backward — the
 *  seed's own references, resolved server-side in one request; verified
 *  live). Pure; exported. */
export function buildOpenAlexFilter(filters?: PaperFilters, leg?: string, direction: "cites" | "citedBy" = "cites"): string {
  const parts: string[] = [];
  if (filters?.year !== undefined) parts.push(`publication_year:${filters.year}`);
  if (filters?.yearRange) {
    parts.push(`from_publication_date:${filters.yearRange[0]}-01-01`);
    parts.push(`to_publication_date:${filters.yearRange[1]}-12-31`);
  }
  if (filters?.openAccess === true) parts.push("is_oa:true");
  if (leg) parts.push(direction === "citedBy" ? `cited_by:${leg}` : `cites:${leg}`);
  return parts.join(",");
}

/** The OpenAlex works query. per-page sized; `api_key` set only when a key
 *  resolves (never sent empty — keyless is a first-class path); `filter` set
 *  only when the caller carries constraints (search or citation walk); `sort`
 *  set only when filters ask for citation ranking (the API default is
 *  relevance). `search` is omitted when the query is empty (a walk has none).
 *  Pure; exported for tests. */
export function buildPaperParams(query: string, numResults: number, apiKey: string | null, filter = "", sort: "citedBy" | undefined = undefined): URLSearchParams {
  const params = new URLSearchParams({
    "per-page": String(numResults),
    // Lean payloads: one shared projection on every works-list call.
    "select": OPENALEX_SELECT,
  });
  if (query) params.set("search", query);
  if (filter) params.set("filter", filter);
  if (apiKey) params.set("api_key", apiKey);
  if (sort === "citedBy") params.set("sort", "cited_by_count:desc");
  return params;
}

// ── Key resolution — config wins, env fallback, keyless tolerated ───────────

/** Precedence: config `papers.openalexApiKey` wins, env `OPENALEX_API_KEY` is
 *  the fallback, absent or blank → keyless (the call must work without a
 *  key — the keyless budget is smaller, not absent). Pure; exported for
 *  tests. */
export function resolveOpenAlexKey(configKey: string | undefined, envKey: string | undefined): string | null {
  const key = configKey?.trim() || envKey?.trim() || "";
  return key === "" ? null : key;
}

/** The live key read — config.ts owns the file, process.env owns the env
 *  var; tests exercise the pure resolver and inject stubs via deps instead
 *  of touching this. */
function readOpenAlexKey(): string | null {
  return resolveOpenAlexKey(loadConfig()?.papers?.openalexApiKey, process.env.OPENALEX_API_KEY);
}

// ── Metering error contract (PIWEB-19) ────────────────────────────────────

/** An OpenAlex HTTP failure carrying the metering headers the 429 contract
 *  reads. Thrown by the default deps; classified by openAlexErrorDetail. */
export class OpenAlexHttpError extends Error {
  readonly status: number;
  readonly remaining: number | null;
  readonly remainingUsd: number | null;
  readonly resetSeconds: number | null;

  constructor(
    status: number,
    remaining: number | null,
    remainingUsd: number | null,
    resetSeconds: number | null,
  ) {
    super(`OpenAlex returned ${status}`);
    this.name = "OpenAlexHttpError";
    this.status = status;
    this.remaining = remaining;
    this.remainingUsd = remainingUsd;
    this.resetSeconds = resetSeconds;
  }
}

/** Tolerant numeric header parse — "9.99", "$0.09", or garbage → number|null. */
function parseNumericHeader(v: string | null): number | null {
  if (v === null) return null;
  const n = Number.parseFloat(v.replace(/^\$/, ""));
  return Number.isFinite(n) ? n : null;
}

function rateLimitHeaders(h: Headers): { remaining: number | null; remainingUsd: number | null; resetSeconds: number | null } {
  return {
    remaining: parseNumericHeader(h.get("X-RateLimit-Remaining")),
    remainingUsd: parseNumericHeader(h.get("X-RateLimit-Remaining-USD")),
    resetSeconds: parseNumericHeader(h.get("X-RateLimit-Reset")),
  };
}

/** The parsed metering headers — shared with the setup wizard's free probe
 *  and budget readout, so both classify from the same grammar. Exported. */
export function parseOpenAlexRateLimitHeaders(h: Headers): ReturnType<typeof rateLimitHeaders> {
  return rateLimitHeaders(h);
}

/** The 429/401/403 slice of the backend-down contract. Classified from the
 *  wire's own headers — never a live probe: remaining (or remaining-USD)
 *  zero → daily credits exhausted; remaining > 0 → temporary throttling
 *  (the >100 req/s limit); 401/403 → key rejected. Keyless exhaustion names
 *  the free key and /openalex-setup; keyed exhaustion names the reset (from
 *  X-RateLimit-Reset — seconds to midnight UTC). The key value itself never
 *  appears in any text. Non-metering statuses → null — the caller falls
 *  back to the generic message. Pure; exported for tests. */
export function openAlexErrorDetail(
  status: number,
  remaining: number | null,
  remainingUsd: number | null,
  resetSeconds: number | null,
  keyed: boolean,
): string | null {
  if (status === 401 || status === 403) {
    return `key rejected (HTTP ${status}) — check papers.openalexApiKey in ~/.pi/agent/pi-reader.json or OPENALEX_API_KEY in the environment`;
  }
  if (status !== 429) return null;
  const exhausted = remaining === 0 || remainingUsd === 0
    // No metering headers at all: assume the daily budget, not the burst —
    // the exhausted text is the actionable one for a session-long caller.
    || (remaining === null && remainingUsd === null);
  if (!exhausted) {
    return "temporary throttling (over 100 requests/s) — retry shortly";
  }
  if (keyed) {
    return resetSeconds !== null
      ? `daily credits exhausted — budget resets in ${Math.ceil(resetSeconds)} seconds (midnight UTC)`
      : "daily credits exhausted — budget resets at midnight UTC";
  }
  return "daily credits exhausted (the keyless daily budget is spent) — a free API key raises the budget 10×: get one at openalex.org/settings/api or run /openalex-setup";
}

/** Wrap any OpenAlex failure as the backend-down contract error; 429/401/403
 *  classify through the metering detail, everything else keeps its message. */
function openAlexBackendDown(err: unknown, keyed: boolean): PaperError {
  if (err instanceof OpenAlexHttpError) {
    const detail = openAlexErrorDetail(err.status, err.remaining, err.remainingUsd, err.resetSeconds, keyed);
    if (detail !== null) return new PaperError(paperError("backend-down", "openalex", detail));
  }
  return new PaperError(paperError("backend-down", "openalex", err instanceof Error ? err.message : String(err)));
}

// ── Adapter (OpenAlex) ───────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface OpenAlexDeps {
  /** Fetch the works endpoint with these params; return the results array. */
  fetchWorks: (params: URLSearchParams, signal?: AbortSignal) => Promise<OpenAlexWork[]>;
  /** Fetch a single work record by lookup ("doi:10.…" or "W…"); null when
   *  the record is absent. Used by the citation walk's seed resolution and
   *  the identifier lookup. apiKey rides the URL as api_key= when present. */
  fetchRecord: (lookup: string, signal?: AbortSignal, apiKey?: string | null) => Promise<OpenAlexWork | null>;
  /** Resolve the api_key credential (config → env → null). Defaults to the
   *  live read; tests inject a stub instead of touching config or env. */
  resolveKey?: () => string | null;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any(
      signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
    ),
  });
  if (!res.ok) {
    const rl = rateLimitHeaders(res.headers);
    throw new OpenAlexHttpError(res.status, rl.remaining, rl.remainingUsd, rl.resetSeconds);
  }
  return res.json() as unknown;
}

export const defaultOpenAlexDeps: OpenAlexDeps = {
  async fetchRecord(lookup, signal, apiKey) {
    const url = apiKey
      ? `https://api.openalex.org/works/${lookup}?${new URLSearchParams({ api_key: apiKey })}`
      : `https://api.openalex.org/works/${lookup}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.any(
        signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
      ),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const rl = rateLimitHeaders(res.headers);
      throw new OpenAlexHttpError(res.status, rl.remaining, rl.remainingUsd, rl.resetSeconds);
    }
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

/** The OpenAlex citation walk (PIWEB-16, made exact by PIWEB-21). Both
 *  directions are one server-side works query on the seed's W-id, filters
 *  combined in the same filter list: forward = `cites:{seed}` (works citing
 *  the seed), backward = `cited_by:{seed}` (the seed's own references —
 *  verified live: 133 refs returned in one request where the forward filter
 *  returned 8,092). DOI seeds resolve through one free singleton record
 *  fetch first; PMID/PMCID seeds are Europe PMC's vocabulary — the in-band
 *  error names the other index with the concrete identifier. */
async function searchOpenAlexWalk(
  graph: PaperCitationGraph,
  n: number,
  options: SearchOptions,
  deps: OpenAlexDeps,
  key: string | null,
): Promise<PaperRecord[]> {
  const keyed = key !== null;
  const seed = parsePaperSeed(graph.seed);
  if (seed === null) {
    throw new PaperError(paperError("malformed", "openalex", `unreadable seed "${graph.seed}" — pass a DOI, PMID, PMCID, or OpenAlex W-id`));
  }
  if (seed.kind === "pmid" || seed.kind === "pmcid") {
    throw new PaperError(paperError("malformed", "openalex", `seed is a ${seed.kind} id (${seed.value}); OpenAlex walks need a DOI or W-id — retry with index: "europepmc" and the same seed`));
  }
  let wId: string;
  try {
    if (seed.kind === "openalex") {
      wId = bareOpenAlexId(seed.value);
    } else {
      const rec = await deps.fetchRecord(`doi:${seed.value}`, options.signal, key);
      if (rec === null) {
        throw new PaperError(paperError("no-results", "openalex", `seed DOI "${seed.value}" matched no OpenAlex record`));
      }
      wId = bareOpenAlexId(rec.id ?? "");
    }
    // One server-side call per walk — cited_by:W… is the seed's reference
    // list resolved by the index; no chunk loop, no OR-cap math.
    return await fetchOpenAlexWorks(
      buildPaperParams("", n, key, buildOpenAlexFilter(options.filters, wId, graph.direction ?? "cites")),
      n,
      options,
      deps,
      keyed,
    );
  } catch (err) {
    if (err instanceof PaperError) throw err;
    throw openAlexBackendDown(err, keyed);
  }
}

/** One works-list fetch → normalized records; failure shaped as the contract
 *  error. Shared by the search and walk paths. `keyed` feeds the metering
 *  classification (429 exhausted text differs for keyed vs keyless callers). */
async function fetchOpenAlexWorks(
  params: URLSearchParams,
  n: number,
  options: SearchOptions,
  deps: OpenAlexDeps,
  keyed: boolean,
): Promise<PaperRecord[]> {
  let results: PaperRecord[];
  try {
    const works = await deps.fetchWorks(params, options.signal);
    results = normalizePaperResults(works);
  } catch (err) {
    throw openAlexBackendDown(err, keyed);
  }
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
  const key = (deps.resolveKey ?? readOpenAlexKey)();
  const graph = options.filters?.citationGraph;
  if (graph) return searchOpenAlexWalk(graph, n, options, deps, key);
  const params = buildPaperParams(query, n, key, buildOpenAlexFilter(options.filters), options.filters?.sort);
  return fetchOpenAlexWorks(params, n, options, deps, key !== null);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** The identifier lookup: resolve ONE paper from a parsePaperSeed form (DOI
 *  or doi.org link, PMID, PMCID, Europe PMC/NCBI article URL, OpenAlex W-id)
 *  into a single citeable record. The identifier picks the backend — DOI
 *  and W-ids are OpenAlex's vocabulary, PMID/PMCID are Europe PMC's — so
 *  `index` is ignored here, and the other filters don't apply (a lookup
 *  retrieves, it doesn't constrain). One OpenAlex wire form: /works/{doi}
 *  and /works/{W-id} are the same record endpoint (verified live), the
 *  same call the backward walk's DOI seed already makes. */
export async function searchPaperLookup(
  seed: string,
  options: SearchOptions = {},
  deps: { openalex?: OpenAlexDeps; europepmc?: EuropePmcDeps } = {},
): Promise<PaperRecord[]> {
  const parsed = parsePaperSeed(seed);
  if (parsed === null) {
    throw new PaperError(paperError("malformed", "openalex",
      `not a paper identifier: "${seed}" — use a DOI, PMID, PMCID, Europe PMC/NCBI article URL, or OpenAlex W-id`));
  }
  if (parsed.kind === "pmid" || parsed.kind === "pmcid") {
    return searchEuropePmcLookup(parsed, options, deps.europepmc ?? defaultEuropePmcDeps);
  }
  const lookup = parsed.kind === "openalex" ? bareOpenAlexId(parsed.value) : `doi:${parsed.value}`;
  const oaDeps = deps.openalex ?? defaultOpenAlexDeps;
  const key = (oaDeps.resolveKey ?? readOpenAlexKey)();
  let rec: OpenAlexWork | null;
  try {
    rec = await oaDeps.fetchRecord(lookup, options.signal, key);
  } catch (err) {
    throw openAlexBackendDown(err, key !== null);
  }
  if (rec === null) {
    throw new PaperError(paperError("no-results", "openalex", `"${seed}" matched no OpenAlex record`));
  }
  return normalizePaperResults([rec]);
}

/** Search the papers vertical. `index` selects the backend ("openalex"
 *  default, "europepmc" for biomedical full text). Throws PaperError whose
 *  message IS the in-band error text — named backend, retry hint, status
 *  distinction — so the entry passes it through verbatim. */
export async function searchPapers(
  query: string,
  options: SearchOptions = {},
  deps: { openalex?: OpenAlexDeps; europepmc?: EuropePmcDeps } = {},
): Promise<PaperRecord[]> {
  // Lookup rides the same seam as search — one filters bag, three modes
  // (search / walk / lookup), dispatched here at the one fork point.
  if (options.filters?.lookup !== undefined) {
    if (options.filters.citationGraph !== undefined) {
      throw new PaperError(paperError("malformed", "openalex",
        "filters.lookup and filters.citationGraph are mutually exclusive — one intent per call"));
    }
    return searchPaperLookup(options.filters.lookup, options, deps);
  }
  const requested = (options.index ?? "openalex") as PaperIndexName;
  const index = PAPER_INDEXES.includes(requested)
    ? requested
    : "openalex";
  return index === "europepmc"
    ? searchEuropePmc(query, options, deps.europepmc ?? defaultEuropePmcDeps)
    : searchOpenAlex(query, options, deps.openalex ?? defaultOpenAlexDeps);
}
