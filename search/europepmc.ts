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
//   url         ← doi.org URL when doi present (stable), else the PMC
//                 article landing page, else the Europe PMC record page
//   oaUrl       ← inEPMC === "Y" or inPMC === "Y" → the PMC article URL
//                 Europe PMC's own inEPMC record is the full-text body
//   snippet     ← buildPaperSnippet (shared): venue · year · citations ·
//                 open/closed badge · first author et al.
//
// Records with no record URL at all are dropped — no url, no action.

import type { PaperIndexName } from "./search.ts";
import { DEFAULT_PAGE_SIZE, buildPaperSnippet, paperError, PaperError, type PaperRecord } from "./paper-backend.ts";

const TIMEOUT_MS = 25_000;
const EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

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
  pubYear?: string;
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
}

// ── Pure seams ───────────────────────────────────────────────────────────────

/** y/n string flag → boolean, tolerating absent. Pure; exported for tests. */
export function isFlagY(v: string | undefined): boolean {
  return v === "Y" || v === "y";
}

/** `url` — doi.org when doi present (stable, resolvable), else the PMC copy
 *  page, else the Europe PMC record page by source+id. Pure; exported. */
export function chooseRecordUrl(r: EuropePmcResult): string | null {
  if (r.doi) return `https://doi.org/${r.doi}`;
  if (r.pmcid) return `https://europepmc.org/article/${r.pmcid}`;
  if (r.id && r.source) return `https://europepmc.org/article/${r.source}/${r.id}`;
  return null;
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
        venue: r.journalInfo?.journal?.title ?? r.journalTitle,
        year: r.pubYear !== undefined ? Number.parseInt(r.pubYear, 10) || undefined : undefined,
        citedBy: r.citedByCount,
        authors: parseAuthors(r.authorString),
        oaToken: isFlagY(r.isOpenAccess) ? "open" : "closed",
      }),
    };
    if (r.pubYear !== undefined) {
      const year = Number.parseInt(r.pubYear, 10);
      if (!Number.isNaN(year)) rec.year = year;
    }
    const authors = parseAuthors(r.authorString);
    if (authors) rec.authors = authors;
    const venue = r.journalInfo?.journal?.title ?? r.journalTitle;
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
  return new URLSearchParams({
    query,
    format: "json",
    pageSize: String(numResults),
  });
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface EuropePmcDeps {
  /** Fetch the search endpoint with these params; return the parsed body. */
  fetchResults: (params: URLSearchParams, signal?: AbortSignal) => Promise<EuropePmcResponse>;
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
    const body = await epmcFetch(`${EPMC_BASE}?${params}`, signal);
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
};

/** Search the papers vertical's Europe PMC backend. Throws PaperError whose
 *  message IS the in-band error text — named backend, retry hint, status
 *  distinction — so the entry passes it through verbatim. */
export async function searchEuropePmc(
  query: string,
  options: { numResults?: number; signal?: AbortSignal } = {},
  deps: EuropePmcDeps = defaultEuropePmcDeps,
): Promise<PaperRecord[]> {
  const n = options.numResults ?? DEFAULT_PAGE_SIZE;
  const params = buildEuropePmcParams(query, n);
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
