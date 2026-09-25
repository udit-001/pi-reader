// europepmc.ts — Europe PMC backend for the papers vertical: biomedical
// literature via the Europe PMC REST API (no key, covers PubMed abstracts,
// PMC full text, preprints, and patents). Selected with index: "europepmc"
// when the query is biomedical and full text matters — OpenAlex metadata only
// names a paper; Europe PMC can point at the PMC copy itself.
//
// Normalizes into the SAME PaperRecord shape as the OpenAlex backend — no
// per-backend forking downstream. Mapping decisions:
//   year        ← pubYear          (string in the API → number)
//   authors     ← authorString (comma-separated, bibliographic "Surname I"
//                 order preserved as-is — the agent only reads them)
//   venue       ← journalInfo.journal.title, else journalTitle
//   citedBy     ← citedByCount
//   doi         ← the bare doi field (Europe PMC ships it bare already)
//   url         ← the most fetchable copy (shared chooseFetchableUrl):
//                 the PMC article page when a PMCID exists, else the
//                 doi.org resolution, else the Europe PMC record page
//   oaUrl       ← inEPMC === "Y" or inPMC === "Y" → the PMC article URL
//                 Europe PMC's own inEPMC record is the full-text body
//   snippet     ← buildPaperSnippet (shared): venue · year · citations ·
//                 open/closed badge · first author et al.
//
// Records with no record URL at all are dropped — no url, no action.

import type { PaperIndexName, SearchOptions } from "./search.ts";
import {
  DEFAULT_PAGE_SIZE,
  applyYearFilter,
  applySort,
  buildPaperSnippet,
  chooseFetchableUrl,
  paperError,
  parsePaperSeed,
  PaperError,
  type PaperCitationGraph,
  type PaperFilters,
  type PaperRecord,
  type PaperSeed,
} from "./paper-backend.ts";

const TIMEOUT_MS = 25_000;
const EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";

// ── Raw shape (Europe PMC result — trimmed live capture 2026-09-25) ──────────
// resultType=lite (the default). Only the fields normalization reads are
// named; pagination cursors, sources, textMined flags, and the rest are
// dropped no-ops.

export interface EuropePmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  /** Bare DOI — carried bare everywhere in the world, followed bare. */
  doi?: string;
  title?: string;
  /** Comma-separated bibliographic author string ("Surname I, Surname J, ..."). */
  authorString?: string;
  journalTitle?: string;
  journalInfo?: { journal?: { title?: string } | null };
  /** Citation/reference walk entries carry the abbreviated journal instead. */
  journalAbbreviation?: string;
  /** Search entries ship it as a string; walk entries as a number. */
  pubYear?: string | number;
  citedByCount?: number;
  /** "Y"/"N" — full text available in the Europe PMC / PMC copies. */
  inEPMC?: string;
  inPMC?: string;
  /** "Y"/"N" — open-access classification (public access tag). */
  isOpenAccess?: string;
  [key: string]: unknown;
}

export interface EuropePmcResponse {
  /** hitCount even when resultList missing — malformed-detection reads it. */
  hitCount?: number;
  resultList?: { result?: EuropePmcResult[] } | null;
  /** The citation-walk endpoints return these instead of resultList. */
  citationList?: { citation?: EuropePmcResult[] } | null;
  referenceList?: { reference?: EuropePmcResult[] } | null;
}

/** Walk entries ship pubYear as a number, search entries as a string.
 *  Absent/unparseable → undefined; never invented. Pure; exported for
 *  tests. */
export function parsePubYear(pubYear: string | number | undefined): number | undefined {
  if (pubYear === undefined) return undefined;
  if (typeof pubYear === "number") return pubYear;
  const year = Number.parseInt(pubYear, 10);
  return Number.isNaN(year) ? undefined : year;
}

// ── Pure seams ───────────────────────────────────────────────────────────────

/** y/n string flag → boolean, tolerating absent. Pure; exported for tests. */
export function isFlagY(v: string | undefined): boolean {
  return v === "Y" || v === "y";
}

/** `url` — the most fetchable copy, through the shared policy
 *  (chooseFetchableUrl): the PMC copy page first (Europe PMC serves its full
 *  text keyless), then the doi.org resolution, then the record page by
 *  source+id. Pure; exported. */
export function chooseRecordUrl(r: EuropePmcResult): string | null {
  return chooseFetchableUrl([
    r.pmcid ? `https://europepmc.org/article/${r.pmcid}` : undefined,
    r.doi ? `https://doi.org/${r.doi}` : undefined,
    r.id && r.source ? `https://europepmc.org/article/${r.source}/${r.id}` : undefined,
  ]);
}

/** `oaUrl` — the full-text body when a PMC copy exists; absent (closed or
 *  metadata-only, or no id to anchor the URL) otherwise. Pure; exported. */
export function chooseOaUrl(r: EuropePmcResult): string | null {
  if (r.pmcid === undefined && r.id === undefined) return null;
  if (isFlagY(r.inEPMC)) return `https://europepmc.org/article/${r.pmcid ?? r.id}`;
  if (isFlagY(r.inPMC) && r.pmcid !== undefined) {
    return `https://www.ncbi.nlm.nih.gov/pmc/articles/${r.pmcid}/`;
  }
  return null;
}

/** authors — split authorString on commas, trimmed; the API already carries
 *  one canonical order. Empty/absent → undefined (no empty array). Pure. */
export function parseAuthors(authorString: string | undefined): string[] | undefined {
  const authors = (authorString ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return authors.length > 0 ? authors : undefined;
}

// ── Normalization (agent-POV) ────────────────────────────────────────────────

/** Europe PMC results → PaperRecords, the same flat keys the OpenAlex
 *  backend produces. Works with no record URL are dropped. Pure; exported
 *  for tests. */
export function normalizeEuropePmcResults(results: EuropePmcResult[]): PaperRecord[] {
  const records: PaperRecord[] = [];
  for (const r of results) {
    const url = chooseRecordUrl(r);
    if (url === null) continue;
    const rec: PaperRecord = {
      title: r.title ?? "",
      url,
      snippet: buildPaperSnippet({
        venue: r.journalInfo?.journal?.title ?? r.journalTitle ?? r.journalAbbreviation,
        year: parsePubYear(r.pubYear),
        citedBy: r.citedByCount,
        authors: parseAuthors(r.authorString),
        oaToken: isFlagY(r.isOpenAccess) ? "open" : "closed",
      }),
    };
    const year = parsePubYear(r.pubYear);
    if (year !== undefined) rec.year = year;
    const authors = parseAuthors(r.authorString);
    if (authors) rec.authors = authors;
    const venue = r.journalInfo?.journal?.title ?? r.journalTitle ?? r.journalAbbreviation;
    if (venue) rec.venue = venue;
    if (r.citedByCount !== undefined) rec.citedBy = r.citedByCount;
    const oaUrl = chooseOaUrl(r);
    if (oaUrl) rec.oaUrl = oaUrl;
    if (r.doi) rec.doi = r.doi;
    records.push(rec);
  }
  return records;
}

// ── Pure seam: request params ────────────────────────────────────────────────

/** Build the Europe PMC search query: query + format + pageSize. Pure;
 *  exported for tests. */
export function buildEuropePmcParams(query: string, numResults: number): URLSearchParams {
  const params = new URLSearchParams({
    format: "json",
    pageSize: String(numResults),
  });
  if (query) params.set("query", query);
  return params;
}

// ── Pure seam: filters ───────────────────────────────────────────────────────

/** Europe PMC filters ride INSIDE the query string (field syntax), unlike
 *  OpenAlex's separate filter param. Year exact: PUB_YEAR:"2023"; range:
 *  (PUB_YEAR:[2019 TO 2021]); OA: OPEN_ACCESS:y — all verified live. Pure;
 *  exported for tests. */
export function buildEuropePmcFilterQuery(query: string, filters?: PaperFilters): string {
  const conds: string[] = [];
  if (filters?.year !== undefined) conds.push(`PUB_YEAR:"${filters.year}"`);
  if (filters?.yearRange) conds.push(`(PUB_YEAR:[${filters.yearRange[0]} TO ${filters.yearRange[1]}])`);
  if (filters?.openAccess === true) conds.push("OPEN_ACCESS:y");
  if (conds.length === 0) return query;
  return query ? `${query} AND ${conds.join(" AND ")}` : conds.join(" AND ");
}

/** The Europe PMC citation walk is endpoint-based — the search query has no
 *  CITES field (verified live, hitCount 0) — so the plan is a REST route:
 *  /rest/{src}/{id}/citations for the forward walk, /references for the
 *  backward one. This endpoint pair IS the documented approximation. Pure;
 *  exported for tests. */
export function planEuropePmcWalk(src: string, id: string, direction: "cites" | "citedBy"): string {
  return `${src}/${id}/${direction === "citedBy" ? "references" : "citations"}`;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface EuropePmcDeps {
  /** Fetch the search endpoint with these params; return the parsed body. */
  fetchResults: (params: URLSearchParams, signal?: AbortSignal) => Promise<EuropePmcResponse>;
  /** Fetch a citation-walk route (`{src}/{id}/citations|references`) with the
   *  given params; same parsed-body contract. */
  fetchRoute: (path: string, params: URLSearchParams, signal?: AbortSignal) => Promise<EuropePmcResponse>;
}

async function epmcFetch(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any(
      signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
    ),
  });
  if (!res.ok) throw new Error(`Europe PMC returned ${res.status}`);
  return res.json() as unknown;
}

export const defaultEuropePmcDeps: EuropePmcDeps = {
  async fetchResults(params, signal) {
    const body = await epmcFetch(`${EPMC_BASE}/search?${params}`, signal);
    if (body === null || typeof body !== "object") {
      throw new Error("Europe PMC response is not an object");
    }
    // A 400 from the API comes back as {errorList: [...]} with no hitCount —
    // that's the malformed-query case, not a backend-down case.
    const b = body as { hitCount?: unknown; errorList?: unknown };
    if (b.hitCount === undefined) {
      throw new PaperError(paperError("malformed", "europepmc", "no hitCount in response"));
    }
    return body as EuropePmcResponse;
  },
  async fetchRoute(path, params, signal) {
    const body = await epmcFetch(`${EPMC_BASE}/${path}?${params}`, signal);
    if (body === null || typeof body !== "object") {
      throw new Error("Europe PMC response is not an object");
    }
    return body as EuropePmcResponse;
  },
};

/** Wrap a route fetch the same way the search fetch is wrapped — 4xx except
 *  429 is malformed, everything else backend-down. */
async function fetchShaped(fetcher: () => Promise<EuropePmcResponse>): Promise<EuropePmcResponse> {
  try {
    return await fetcher();
  } catch (err) {
    if (err instanceof PaperError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const status = /returned 4\d\d/.test(message) && !/returned 429/.test(message)
      ? "malformed"
      : "backend-down";
    throw new PaperError(paperError(status, "europepmc", message));
  }
}

/** Resolve a DOI seed to its Europe PMC anchor ({source, id}) via the search
 *  endpoint — the walk routes key on MED/PMC ids, not DOIs. */
async function resolveSeed(
  seed: PaperSeed,
  deps: EuropePmcDeps,
  signal?: AbortSignal,
): Promise<{ src: string; id: string }> {
  if (seed.kind === "pmid") return { src: "MED", id: seed.value };
  if (seed.kind === "pmcid") return { src: "PMC", id: seed.value };
  // DOI: one lookup through the search endpoint, first hit is the anchor.
  const body = await fetchShaped(() => deps.fetchResults(
    buildEuropePmcParams(`DOI:"${seed.value}"`, 1),
    signal,
  ));
  const first = body.resultList?.result?.[0];
  if (first === undefined || first.id === undefined) {
    throw new PaperError(paperError("no-results", "europepmc", `seed DOI "${seed.value}" matched no Europe PMC record`));
  }
  return { src: first.source ?? "MED", id: first.id };
}

/** The citation walk (PIWEB-16): forward = works citing the seed
 *  (/citations), backward = the seed's references (/references). Filters on
 *  the walk: year applies post-fetch (applyYearFilter — the walk endpoints
 *  take no filter params); openAccess can't be verified on walk entries and
 *  is dropped, the documented approximation. */
async function searchEuropePmcWalk(
  graph: PaperCitationGraph,
  n: number,
  options: SearchOptions,
  deps: EuropePmcDeps,
): Promise<PaperRecord[]> {
  const seed = parsePaperSeed(graph.seed);
  if (seed === null) {
    throw new PaperError(paperError("malformed", "europepmc", `unreadable seed "${graph.seed}" — pass a DOI, PMID, PMCID, or OpenAlex W-id`));
  }
  if (seed.kind === "openalex") {
    throw new PaperError(paperError("malformed", "europepmc", `seed is an OpenAlex id; Europe PMC walks need a PMID, PMCID, or DOI — retry with index: "openalex"`));
  }
  let anchor: { src: string; id: string };
  try {
    anchor = await resolveSeed(seed, deps, options.signal);
  } catch (err) {
    if (err instanceof PaperError) throw err;
    throw new PaperError(paperError("backend-down", "europepmc", err instanceof Error ? err.message : String(err)));
  }
  const path = planEuropePmcWalk(anchor.src, anchor.id, graph.direction ?? "cites");
  const body = await fetchShaped(() => deps.fetchRoute(path, buildEuropePmcParams("", n), options.signal));
  const raw = body.citationList?.citation ?? body.referenceList?.reference ?? [];
  const records = applySort(applyYearFilter(normalizeEuropePmcResults(raw), options.filters), options.filters);
  if (records.length === 0) {
    throw new PaperError(paperError("no-results", "europepmc"));
  }
  return records.slice(0, n);
}

/** Search the papers vertical's Europe PMC backend. Throws PaperError whose
 *  message IS the in-band error text — named backend, retry hint, status
 *  distinction — so the entry passes it through verbatim. */
export async function searchEuropePmc(
  query: string,
  options: SearchOptions = {},
  deps: EuropePmcDeps = defaultEuropePmcDeps,
): Promise<PaperRecord[]> {
  const n = options.numResults ?? DEFAULT_PAGE_SIZE;
  const graph = options.filters?.citationGraph;
  if (graph) return searchEuropePmcWalk(graph, n, options, deps);
  const params = buildEuropePmcParams(buildEuropePmcFilterQuery(query, options.filters), n);
  let body: EuropePmcResponse;
  try {
    body = await deps.fetchResults(params, options.signal);
  } catch (err) {
    if (err instanceof PaperError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // 4xx (except 429) is the API rejecting the request — the malformed-query
    // case; every other failure is the backend being down. Live behavior:
    // Europe PMC's parser is loose (unbalanced quotes don't 400), so a 400 is
    // a genuinely rejected query, not parser fuzz.
    const status = /returned 4\d\d/.test(message) && !/returned 429/.test(message)
      ? "malformed"
      : "backend-down";
    throw new PaperError(paperError(status, "europepmc", message));
  }
  const results = normalizeEuropePmcResults(body.resultList?.result ?? []);
  if (results.length === 0) {
    throw new PaperError(paperError("no-results", "europepmc"));
  }
  return results.slice(0, n);
}

/** The index name this adapter serves — attached to the adapter's export so
 *  the dispatcher's record keeps a single source of truth. */
export const EUROPEPMC_INDEX: PaperIndexName = "europepmc";
