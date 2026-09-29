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
  paperPage,
  parsePaperSeed,
  type PaperCitationGraph,
  type PaperFilters,
  type PaperInstitution,
  type PaperPage,
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
export const OPENALEX_SELECT = "id,doi,title,publication_year,cited_by_count,is_retracted,type,open_access,best_oa_location,primary_location,authorships,locations,primary_topic,ids,fwci,referenced_works,related_works,counts_by_year,topics,keywords,abstract_inverted_index";

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
    /** The hosting venue: its name, and its kind ("journal", "repository",
     *  "conference", …) — a repository tells you the work is a preprint or
     *  an archived copy rather than a peer-reviewed article. */
    source?: { display_name?: string; type?: string | null } | null;
  } | null;
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null } | null;
  best_oa_location?: { landing_page_url?: string; pdf_url?: string | null } | null;
  /** Every copy the work has a record of: publisher, PMC, DOAJ, repositories.
   *  Landing pages here are the raw record URL — most are doi.org forms, but
 *  the PMC/DOAJ/repo copies are not, and they are what fetches cleanly. */
  locations?: Array<{ landing_page_url?: string | null } | null> | null;
  authorships?: Array<{
    author?: { display_name?: string } | null;
    /** Every institution this author claims on the work — two or more for a
     *  dual-affiliated researcher. Empty (not absent) when the API lists
     *  none. */
    institutions?: Array<{
      id?: string | null;
      display_name?: string | null;
      /** ror.org URL form; the record keeps the bare id. */
      ror?: string | null;
      country_code?: string | null;
      type?: string | null;
    } | null> | null;
  }>;
  /** Field-weighted citation impact — 1.0 = exactly field-typical for the
 *  work's topic+year+type cohort. Absent when the index doesn't know. */
  fwci?: number;
  /** The work's own bibliography as OpenAlex work URLs ("https://openalex
 *  .org/W…"). Big papers carry hundreds — the normalizer caps what it
 *  keeps. */
  referenced_works?: string[] | null;
  related_works?: string[] | null;
  /** Per-year citation counts — the recency label reads the last three
 *  complete years off it, not all of it. */
  counts_by_year?: Array<{ year: number; cited_by_count: number }> | null;
  topics?: Array<{
    display_name?: string | null;
    score?: number | null;
    field?: { display_name?: string | null } | null;
  }> | null;
  keywords?: Array<{ display_name?: string | null }> | null;
  /** Token-position encoding of the abstract — the normalizer rebuilds the
 *  plaintext and truncates. Absent/null tolerated (works without abstracts
 *  are common). */
  abstract_inverted_index?: Record<string, number[]> | null;
  [key: string]: unknown;
}

// ── Pure seams (OpenAlex): DOI parse, URL choice, OA URL choice ──────────

/** Keep at most the first `cap` entries of a W-id list, tolerating absent —
 *  the wire carries URL forms ("https://openalex.org/W…"), the record keeps
 *  bare ids. Pure; exported for tests. */
export function capIds(ids: string[] | null | undefined, cap: number): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    out.push(id.replace(/^https?:\/\/openalex\.org\//, ""));
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : undefined;
}

/** The citation trajectory over the last three complete publication years
 *  (never the current year — it is always partial and reads as a crash).
 *  Counts only within the paper's own window. Returns {recent, trend}: rising
 *  when the newest year outscores the previous, fading when it underscores by
 *  half or more, steady otherwise. Needs ≥ 2 known years. Pure; exported. */
export function citationTrend(counts: Array<{ year: number; cited_by_count: number }> | null | undefined, now = new Date().getUTCFullYear()): { recent: number | undefined; trend: "rising" | "steady" | "fading" | undefined } {
  if (!Array.isArray(counts) || counts.length === 0) return { recent: undefined, trend: undefined };
  const byYear = new Map(counts.map((c) => [c.year, c.cited_by_count]));
  const y1 = now - 1, y2 = now - 2, y3 = now - 3;
  if (!byYear.has(y1) || !byYear.has(y2)) return { recent: undefined, trend: undefined };
  const a = byYear.get(y1)!, b = byYear.get(y2)!, c = byYear.get(y3);
  const recent = a + b + (c ?? 0);
  const trend = a > b ? "rising" : b >= 2 * a ? "fading" : "steady";
  return { recent, trend };
}

/** Abstract: rebuild plaintext from OpenAlex's token-position inverted index
 *  (word → positions), then truncate to 300 chars. Absent/empty → undefined
 *  — never invented. Pure; exported for tests. */
export function abstractFromInvertedIndex(idx: Record<string, number[]> | null | undefined): string | undefined {
  if (idx === null || typeof idx !== "object") return undefined;
  const slots: Array<string | undefined> = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && p >= 0 && Number.isInteger(p)) {
        while (slots.length <= p) slots.push(undefined);
        slots[p] = word;
      }
    }
  }
  const text = slots.filter((w): w is string => w !== undefined).join(" ").trim();
  if (!text) return undefined;
  return elide(text, 300);
}

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

/** OpenAlex carries the ROR as an https URL ("https://ror.org/05a0ya142");
 *  the record keeps the bare identifier, the way it keeps a bare DOI. Absent
 *  or non-ROR → null (never invented). Pure; module-private. */
function bareRor(ror: string | null | undefined): string | null {
  if (typeof ror !== "string") return null;
  const m = ror.match(/^https?:\/\/ror\.org\/(.+)$/i);
  return m?.[1] ?? null;
}

/** Every institution a work's authors claim, in authorship order, one entry
 *  per institution — a dual-affiliated author and a co-author at the same lab
 *  both collapse to one. The stable id dedupes when the API gives one, the
 *  display name otherwise (the same lab must not appear twice under two
 *  spellings). No institution is invented; a work that lists none → undefined.
 *  Pure; module-private. */
function dedupeInstitutions(authorships: OpenAlexWork["authorships"]): PaperInstitution[] | undefined {
  const seen = new Set<string>();
  const out: PaperInstitution[] = [];
  for (const a of authorships ?? []) {
    for (const inst of a?.institutions ?? []) {
      const name = inst?.display_name;
      if (typeof name !== "string" || name === "") continue;
      const key = typeof inst?.id === "string" && inst.id ? inst.id : name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: PaperInstitution = { name };
      if (typeof inst?.type === "string" && inst.type) entry.type = inst.type;
      if (typeof inst?.country_code === "string" && inst.country_code) entry.country = inst.country_code;
      const ror = bareRor(inst?.ror);
      if (ror) entry.ror = ror;
      out.push(entry);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** OpenAlex works → PaperRecords. year←publication_year, authors←authorships
 *  display names, venue←primary_location.source.display_name,
 *  citedBy←cited_by_count, oaUrl←chooseOaUrl (absent when closed), doi←
 *  parseDoi, url←chooseRecordUrl, retracted←is_retracted, topic←
 *  primary_topic.display_name, type←type — plus the deep-research keys:
 *  fwci←fwci, refs←referenced_works (capped 40), related←related_works
 *  (capped 10), openalexId←id, field←topics[0].field, keywords←the first 3
 *  keyword names, recentCitations/citationTrend←counts_by_year's last three
 *  complete years, content←abstract rebuilt from the inverted index and
 *  truncated to ~300 chars. Enrichment keys absent-tolerant, never
 *  invented. Works with no record URL are dropped — no url, no action.
 *  Pure; exported for tests. */
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
    if (typeof w.fwci === "number" && Number.isFinite(w.fwci)) rec.fwci = w.fwci;
    const refs = capIds(w.referenced_works, 40);
    if (refs) rec.refs = refs;
    const related = capIds(w.related_works, 10);
    if (related) rec.related = related;
    const { recent, trend } = citationTrend(w.counts_by_year);
    if (recent !== undefined) rec.recentCitations = recent;
    if (trend !== undefined) rec.citationTrend = trend;
    const field = w.topics?.[0]?.field?.display_name;
    if (typeof field === "string" && field) rec.field = field;
    const keywords = (w.keywords ?? [])
      .map((k) => k?.display_name)
      .filter((n): n is string => typeof n === "string")
      .slice(0, 3);
    if (keywords.length > 0) rec.keywords = keywords;
    const wId = bareOpenAlexId(w.id ?? "");
    if (/^W\d+$/.test(wId)) rec.openalexId = wId;
    const institutions = dedupeInstitutions(w.authorships);
    if (institutions) rec.institutions = institutions;
    const venueType = w.primary_location?.source?.type;
    if (typeof venueType === "string" && venueType) rec.venueType = venueType;
    // The list is returned whole; `refs` caps at 40 for the record, but the
    // count must not follow the cap — a 451-reference work is not a
    // 40-reference work. Verified live: the length matches the API's own
    // referenced_works_count on every sampled work.
    if (Array.isArray(w.referenced_works)) rec.refCount = w.referenced_works.length;
    const abstract = abstractFromInvertedIndex(w.abstract_inverted_index);
    if (abstract) rec.content = abstract;
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
  // Retracted works default to server-side exclusion (the reading-candidate
  // default); includeRetracted drops the clause rather than badging.
  if (filters?.includeRetracted !== true) parts.push("is_retracted:false");
  if (filters?.year !== undefined) parts.push(`publication_year:${filters.year}`);
  if (filters?.yearRange) {
    parts.push(`from_publication_date:${filters.yearRange[0]}-01-01`);
    parts.push(`to_publication_date:${filters.yearRange[1]}-12-31`);
  }
  if (filters?.openAccess === true) parts.push("is_oa:true");
  if (leg) parts.push(direction === "citedBy" ? `cited_by:${leg}` : `cites:${leg}`);
  return parts.join(",");
}

// ── Pure seam: the expression door (PIWEB-24/26) ─────────────────────────────

/** The filter language's own spelling of "not retracted" — the plugin's
 *  clause, merged into the agent's expression by default. */
export const OPENALEX_RETRACTION_CLAUSE = "is_retracted:false";

/** Split a filter expression on its own clause separator (a comma, except
 *  inside a quoted value). Null when the text is not a filter expression:
 *  every clause must read `field:value`, with a field name that carries no
 *  whitespace and a value that is not empty. That structural test is what
 *  keeps the merge rule off foreign text — OQL (`works where year is (2020)`)
 *  and prose both fail it. Pure; module-private. */
function splitFilterClauses(expression: string): string[] | null {
  const clauses: string[] = [];
  let buf = "";
  let quoted = false;
  for (const ch of expression) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      clauses.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  clauses.push(buf);
  const out: string[] = [];
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*\s*:\s*\S/.test(trimmed)) return null;
    out.push(trimmed);
  }
  return out;
}

/** Fold the plugin's retraction clause into the agent's own filter
 *  expression — the door's one piece of new logic. The clause is appended
 *  only when the expression does not already carry an `is_retracted`
 *  condition, either polarity: an agent that asked FOR retracted works must
 *  not be contradicted. The agent's clauses are never rewritten, reordered
 *  or dropped, and `includeRetracted` leaves the expression alone. Text the
 *  filter grammar cannot read → null, so the caller declines in band instead
 *  of corrupting it. Pure; exported for tests. */
export function mergeRetractionClause(expression: string, includeRetracted?: boolean): string | null {
  const trimmed = expression.trim();
  const clauses = splitFilterClauses(trimmed);
  if (clauses === null) return null;
  if (includeRetracted === true) return trimmed;
  if (clauses.some((c) => /^is_retracted\s*:/i.test(c))) return trimmed;
  return `${trimmed},${OPENALEX_RETRACTION_CLAUSE}`;
}

/** OQL — the API root's sentence language (`works where year is (2020)`) — is
 *  the other syntax an agent may already hold: it names its own entity and its
 *  own clauses. Recognizing it lets the decline answer with the translation
 *  instead of reporting anonymous junk; a miss costs only the generic message,
 *  which is still correct. Pure; module-private. */
function looksLikeOql(text: string): boolean {
  return /^\s*[A-Za-z_]+\s+where\b/i.test(text) || /\bgroup\s+by\b/i.test(text);
}

/** Why the agent's text is not a filter expression, and the form to write
 *  instead. The operator line reappears here on purpose: the schema is many
 *  turns back by the time a call fails, and this is the moment it has to be
 *  read. The retraction scope closes both branches — the clause rides the
 *  filter form only, so an OQL query meets a translation rather than a
 *  silently unexcluded result set. Pure; module-private. */
function expressionDecline(expression: string): string {
  const diagnosis = looksLikeOql(expression)
    // No echo of the offending text: the worked pair already carries an OQL
    // string, and the agent holds what it just sent.
    ? `filters.expression is OQL, the API root's query language — write the classic filter list instead, e.g. "works where year is (2020)" becomes publication_year:2020`
    : `"${expression}" is not a filter expression — write comma-separated field:value clauses instead, e.g. "publication_year:2020,is_oa:true,type:article"`;
  const grouping = /\bgroup\s+by\b/i.test(expression)
    ? " This tool returns works, not counts by group."
    : "";
  return `${diagnosis}. Commas are AND, a pipe is OR within one field, ! negates, > and < compare. Only the filter form excludes retracted works by default.${grouping}`;
}

/** Resolve the agent's expression into the wire `filter=` value. The
 *  expression IS the filter list, so a constraint the plugin still composes
 *  is folded into the agent's text rather than appended beside it — which
 *  would intersect silently — or dropped. An expression the
 *  filter grammar cannot read is rejected in band (the backend would 400 it
 *  anyway, and rerouting an OpenAlex-only syntax to the other index is not a
 *  recovery). Pure; exported for tests. */
export function buildOpenAlexExpressionFilter(filters: PaperFilters): string {
  const conflicts: string[] = [];
  if (filters.year !== undefined) conflicts.push("year");
  if (filters.yearRange !== undefined) conflicts.push("yearRange");
  if (filters.openAccess === true) conflicts.push("openAccess");
  if (filters.citationGraph !== undefined) conflicts.push("citationGraph");
  if (conflicts.length > 0) {
    throw new PaperError(paperError("malformed", "openalex",
      `filters.expression is the whole filter list — fold ${conflicts.join(", ")} into it, e.g. publication_year:2020, is_oa:true, cites:W…|W…`,
      null));
  }
  const merged = mergeRetractionClause(filters.expression ?? "", filters.includeRetracted);
  if (merged === null) {
    throw new PaperError(paperError("malformed", "openalex", expressionDecline(filters.expression ?? ""), null));
  }
  return merged;
}

/** The OpenAlex works query. per-page sized; `api_key` set only when a key
 *  resolves (never sent empty — keyless is a first-class path); `filter` set
 *  only when the caller carries constraints (search or citation walk); `sort`
 *  set only when filters ask for citation ranking (the API default is
 *  relevance). `search` is omitted when the query is empty (a walk has none).
 *  Pure; exported for tests. */
export function buildPaperParams(query: string, numResults: number, apiKey: string | null, filter = "", sort: "citedBy" | undefined = undefined, cursor?: string): URLSearchParams {
  const params = new URLSearchParams({
    "per-page": String(numResults),
    // Lean payloads: one shared projection on every works-list call.
    "select": OPENALEX_SELECT,
  });
  if (query) params.set("search", query);
  if (filter) params.set("filter", filter);
  if (apiKey) params.set("api_key", apiKey);
  if (sort === "citedBy") params.set("sort", "cited_by_count:desc");
  // Cursor paging is the works endpoint's own mechanism; `cursor=*` opens the
  // walk, and the response's `meta.next_cursor` closes the loop.
  if (cursor) params.set("cursor", cursor);
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
 *  reads and the API's own complaint for a rejected request (400). Thrown by
 *  the default deps; classified by openAlexErrorDetail. */
export class OpenAlexHttpError extends Error {
  readonly status: number;
  readonly remaining: number | null;
  readonly remainingUsd: number | null;
  readonly resetSeconds: number | null;
  /** The API's own `message` from a 400 body — quoted as the malformed
   *  cause, bounded where it is rendered, so the agent fixes its cursor or
   *  filter in one turn. */
  readonly detail: string | null;

  constructor(
    status: number,
    remaining: number | null,
    remainingUsd: number | null,
    resetSeconds: number | null,
    detail: string | null = null,
  ) {
    super(`OpenAlex returned ${status}`);
    this.name = "OpenAlexHttpError";
    this.status = status;
    this.remaining = remaining;
    this.remainingUsd = remainingUsd;
    this.resetSeconds = resetSeconds;
    this.detail = detail;
  }
}

/** The API's own error message, read from a non-OK response body. OpenAlex
 *  sends {"error":"...","message":"..."} for a rejected request. */
async function readErrorDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body?.message === "string") return body.message;
    if (typeof body?.error === "string") return body.error;
  } catch {
    // A non-JSON error body carries no complaint to forward.
  }
  return null;
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

/** Truncate to `max` characters with a visible ellipsis — the one place that
 *  decides what a cut-off looks like, so an abstract preview and a backend's
 *  complaint read the same way. Pure; module-private. */
function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How much of a rejected request's complaint reaches the agent. An unknown
 *  filter field makes OpenAlex enumerate every valid field — thousands of
 *  characters of catalogue, measured live — and the opening sentence is the
 *  actionable part. Bounded rather than dropped, with the elision visible, so
 *  the agent can see it is reading a quote. Module-private. */
const COMPLAINT_LIMIT = 240;

/** Wrap any OpenAlex failure as the backend-down contract error; 429/401/403
 *  classify through the metering detail, everything else keeps its message. */
function openAlexBackendDown(err: unknown, keyed: boolean): PaperError {
  if (err instanceof OpenAlexHttpError) {
    // A 400 is the API rejecting the request — a bad cursor or a bad filter
    // clause — not an outage. Surface its own complaint, bounded, so the fix is
    // local. No index retry rides along: Europe PMC cannot read an OpenAlex
    // cursor or filter list, so sending the agent there is a circle.
    if (err.status === 400) {
      return new PaperError(paperError("malformed", "openalex", elide(err.detail?.trim() || "the request was rejected", COMPLAINT_LIMIT), null));
    }
    const detail = openAlexErrorDetail(err.status, err.remaining, err.remainingUsd, err.resetSeconds, keyed);
    if (detail !== null) return new PaperError(paperError("backend-down", "openalex", detail));
  }
  return new PaperError(paperError("backend-down", "openalex", err instanceof Error ? err.message : String(err)));
}

// ── Adapter (OpenAlex) ───────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface OpenAlexDeps {
  /** Fetch the works endpoint with these params; return its results array
   *  together with the pagination cursor the response carried. */
  fetchWorks: (params: URLSearchParams, signal?: AbortSignal) => Promise<OpenAlexWorksPage>;
  /** Fetch a single work record by lookup ("doi:10.…" or "W…"); null when
   *  the record is absent. Used by the citation walk's seed resolution and
   *  the identifier lookup. apiKey rides the URL as api_key= when present. */
  fetchRecord: (lookup: string, signal?: AbortSignal, apiKey?: string | null) => Promise<OpenAlexWork | null>;
  /** Resolve the api_key credential (config → env → null). Defaults to the
   *  live read; tests inject a stub instead of touching config or env. */
  resolveKey?: () => string | null;
}

/** A works-list response: the page's records plus `meta.next_cursor` when the
 *  index has more rows to hand out. Exported so test stubs speak the same
 *  shape the default deps produce. */
export interface OpenAlexWorksPage {
  works: OpenAlexWork[];
  /** null/absent when the result set is exhausted. */
  nextCursor?: string | null;
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
    throw new OpenAlexHttpError(res.status, rl.remaining, rl.remainingUsd, rl.resetSeconds, await readErrorDetail(res));
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
      throw new OpenAlexHttpError(res.status, rl.remaining, rl.remainingUsd, rl.resetSeconds, await readErrorDetail(res));
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
    const next = (body as { meta?: { next_cursor?: unknown } }).meta?.next_cursor;
    return {
      works: results as OpenAlexWork[],
      nextCursor: typeof next === "string" && next !== "" ? next : undefined,
    };
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
): Promise<PaperPage> {
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

/** One works-list fetch → normalized records plus the response's cursor;
 *  failure shaped as the contract error. Shared by the search and walk paths.
 *  `keyed` feeds the metering classification (429 exhausted text differs for
 *  keyed vs keyless callers). */
async function fetchOpenAlexWorks(
  params: URLSearchParams,
  n: number,
  options: SearchOptions,
  deps: OpenAlexDeps,
  keyed: boolean,
): Promise<PaperPage> {
  let results: PaperRecord[];
  let nextCursor: string | undefined;
  try {
    const page = await deps.fetchWorks(params, options.signal);
    results = normalizePaperResults(page.works);
    nextCursor = page.nextCursor ?? undefined;
  } catch (err) {
    throw openAlexBackendDown(err, keyed);
  }
  if (results.length === 0) {
    throw new PaperError(paperError("no-results", "openalex"));
  }
  return paperPage(results, n, nextCursor);
}

/** The OpenAlex backend call: params → one page of records plus the cursor for
 *  the next, failure shaped as the contract error. Backend-specific import;
 *  the shared dispatch lives in searchPapers. */
async function searchOpenAlex(
  query: string,
  options: SearchOptions,
  deps: OpenAlexDeps,
): Promise<PaperPage> {
  const n = options.numResults ?? DEFAULT_PAGE_SIZE;
  const key = (deps.resolveKey ?? readOpenAlexKey)();
  // The expression door: the agent's own filter list, validated and merged.
  // Computed before the walk branch so an expression riding with a walk leg
  // is refused rather than half-applied.
  const filters = options.filters;
  const expressionFilter = filters?.expression !== undefined
    ? buildOpenAlexExpressionFilter(filters)
    : undefined;
  const graph = filters?.citationGraph;
  if (graph) return searchOpenAlexWalk(graph, n, options, deps, key);
  const params = buildPaperParams(
    query, n, key,
    expressionFilter ?? buildOpenAlexFilter(options.filters),
    options.filters?.sort, options.filters?.cursor,
  );
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
): Promise<PaperPage> {
  const parsed = parsePaperSeed(seed);
  if (parsed === null) {
    throw new PaperError(paperError("malformed", "openalex",
      `not a paper identifier: "${seed}" — use a DOI, PMID, PMCID, Europe PMC/NCBI article URL, or OpenAlex W-id`));
  }
  if (parsed.kind === "pmid" || parsed.kind === "pmcid") {
    return { results: await searchEuropePmcLookup(parsed, options, deps.europepmc ?? defaultEuropePmcDeps) };
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
  return { results: normalizePaperResults([rec]) };
}

/** Search the papers vertical. `index` selects the backend ("openalex"
 *  default, "europepmc" for biomedical full text). Throws PaperError whose
 *  message IS the in-band error text — named backend, retry hint, status
 *  distinction — so the entry passes it through verbatim. */
export async function searchPapers(
  query: string,
  options: SearchOptions = {},
  deps: { openalex?: OpenAlexDeps; europepmc?: EuropePmcDeps } = {},
): Promise<PaperPage> {
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
