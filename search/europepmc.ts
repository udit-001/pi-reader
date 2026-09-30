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
  paperPage,
  parsePaperSeed,
  PaperError,
  elide,
  ABSTRACT_MAX,
  type PaperBackendStatus,
  type PaperCitationGraph,
  type PaperFilters,
  type PaperPage,
  type PaperRecord,
  type PaperSeed,
  type PaperSort,
  type PaperInstitution,
  type PaperFullTextUrl,
} from "./paper-backend.ts";

const TIMEOUT_MS = 25_000;
const EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";

/** Europe PMC's per-page ceiling, on every endpoint — verified live 2026-09-30:
 *  pageSize=1000 serves on /search, /references and /citations, while 1001
 *  answers HTTP 200 with zero rows and no hitCount. The tool's own page-size
 *  ceiling is set to this value, which is what makes that silent empty
 *  unsendable rather than a case to guard against. */
export const EUROPEPMC_PAGE_SIZE_MAX = 1000;

// ── Pure seam: the query language ────────────────────────────────────────────

/** The query fields this adapter accepts and documents — one table, so the
 *  composed listing and the validator's check cannot disagree. Anything
 *  outside it is declined in band (docs/papers.md carries the why). Every
 *  field verified live 2026-09-30. */
export const EUROPEPMC_OPERATORS: ReadonlyArray<{ token: string; meaning: string }> = [
  { token: "TITLE", meaning: "words in the title" },
  { token: "ABSTRACT", meaning: "words in the abstract" },
  { token: "TITLE_ABS", meaning: "title or abstract" },
  { token: "AUTH", meaning: "author name" },
  { token: "AFF", meaning: "author affiliation" },
  { token: "JOURNAL", meaning: "journal name" },
  { token: "ISSN", meaning: "journal ISSN" },
  { token: "MESH", meaning: "MeSH descriptor, quoted: \"Malaria\"" },
  { token: "KEYWORD", meaning: "author keyword" },
  { token: "PUB_TYPE", meaning: "review, editorial, retracted publication, …" },
  { token: "GRANT_AGENCY", meaning: "funding agency" },
  { token: "GRANT_ID", meaning: "grant identifier" },
  { token: "PUB_YEAR", meaning: "year, or a range [2019 TO 2021]" },
  { token: "FIRST_PDATE", meaning: "date, or a range [2019-01-01 TO 2021-12-31]" },
  { token: "LANG", meaning: "three-letter code, e.g. eng" },
  { token: "SRC", meaning: "MED, PMC, PPR, PAT, AGR, CBA" },
  { token: "DOI", meaning: "bare, e.g. 10.1038/nature12373" },
  { token: "EXT_ID", meaning: "a PMID goes here, e.g. 22955618" },
  { token: "PMCID", meaning: "e.g. PMC4221854" },
  { token: "OPEN_ACCESS", meaning: "y/n, open access" },
  { token: "HAS_FT", meaning: "y/n, full text present" },
  { token: "HAS_ABSTRACT", meaning: "y/n, abstract present" },
  { token: "HAS_SUPPL", meaning: "y/n, supplementary data present" },
  { token: "IN_EPMC", meaning: "y/n, in Europe PMC" },
  { token: "IN_PMC", meaning: "y/n, in PMC" },
];

/** The operator table as one description-ready string. Composed from the same
 *  table the validator reads, so the named set and the accepted set cannot
 *  drift — the round-trip is asserted in the tests. */
export const EUROPEPMC_OPERATOR_LISTING =
  EUROPEPMC_OPERATORS.map((o) => `${o.token} ${o.meaning}`).join("; ");

/** The sort keys the interface offers, mapped to Europe PMC's own `sort`
 *  values — the backend sorts the whole index, not the fetched page.
 *  Verified live 2026-09-30: both reorder the index with hitCount unchanged,
 *  while an unrecognised key answers HTTP 503 (the outage-lookalike). */
export const EUROPEPMC_SORTS: ReadonlyArray<{ key: PaperSort; value: string }> = [
  { key: "citedBy", value: "CITED desc" },
  { key: "date", value: "P_PDATE_D desc" },
];

/** The Europe PMC `sort` value for an interface sort key, or null when the key
 *  is outside the accepted set. Pure; exported for tests. */
export function europePmcSortValue(key: string | undefined): string | null {
  if (key === undefined) return null;
  return EUROPEPMC_SORTS.find((s) => s.key === key)?.value ?? null;
}

/** The query with quoted values blanked, so a field prefix or a conjunction
 *  inside a phrase is never read as syntax. Pure; module-private. */
function stripQuoted(query: string): string {
  return query.replace(/"[^"]*"/g, '""');
}

/** Field prefixes the query uses that the table does not recognise. Scans the
 *  uppercase `TOKEN:` form, which is EPMC's own field convention, so free
 *  text, booleans, parentheses, quoted values and ranges pass through. Pure;
 *  exported for tests. */
export function unrecognisedEuropePmcOperators(query: string): string[] {
  const known = new Set(EUROPEPMC_OPERATORS.map((o) => o.token));
  const seen = new Set<string>();
  const unknown: string[] = [];
  // Scan outside quoted values: TITLE:"MALARIA: A REVIEW" carries an
  // uppercase colon pair that is data, not a field prefix.
  for (const m of stripQuoted(query).matchAll(/\b([A-Z][A-Z0-9_]+)\s*:/g)) {
    const token = m[1]!;
    if (known.has(token) || seen.has(token)) continue;
    seen.add(token);
    unknown.push(token);
  }
  return unknown;
}

/** Every way the agent's query would be silently repaired or mis-read by
 *  Europe PMC, as in-band detail strings — empty when the query is sound.
 *  Europe PMC returns no error for any of these: it repairs the query or
 *  answers a plausible count for a question that was not asked, which is why
 *  each carries its own cause rather than reading as "no results". Verified
 *  live 2026-09-30. Pure; exported for tests. */
export function europePmcQueryFaults(query: string): string[] {
  const faults: string[] = [];
  // The quote is checked first: an unclosed one makes every later scan
  // unreliable, and it changes the search — the phrase becomes loose terms.
  if ((query.match(/"/g)?.length ?? 0) % 2 === 1) {
    faults.push("unclosed double quote — Europe PMC discards it and searches the words as separate terms, not a phrase; close the quote");
    return faults;
  }
  const unquoted = stripQuoted(query);
  const unknown = unrecognisedEuropePmcOperators(query);
  if (unknown.length > 0) {
    faults.push(`unrecognised query field ${unknown.map((t) => `"${t}"`).join(", ")} — Europe PMC does not reject an unknown prefix, it drops it and returns a plausible count. Accepted fields: ${EUROPEPMC_OPERATORS.map((o) => o.token).join(", ")}`);
  }
  // Parenthesis balance: an unclosed `(` reads as AND, flipping a group
  // written with OR into its AND set — the one repair that changes meaning.
  let depth = 0;
  for (const ch of unquoted) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  if (depth < 0) faults.push('unmatched ")" — Europe PMC discards it; remove it');
  else if (depth > 0) faults.push('unclosed parenthesis — Europe PMC reads the missing close as AND, so a group written with OR returns its AND set; add the ")"');
  if (/\(\s*\)/.test(unquoted)) faults.push('empty "()" — Europe PMC discards it; remove it');
  const doubled = unquoted.match(/\b(AND|OR|NOT)\s+(AND|OR|NOT)\b/i);
  if (doubled) {
    const first = doubled[1]!.toUpperCase();
    const second = doubled[2]!.toUpperCase();
    // `X NOT Y` is the standard negation form — only same-kind pairs, and the
    // AND/OR mix, are doubled operators.
    if (second !== "NOT" || first === "NOT") {
      const pair = `${first} ${second}`;
      faults.push(/OR/.test(pair) || first === "NOT"
        ? `doubled "${pair}" — Europe PMC reads it as AND; write one`
        : `doubled "${pair}" — Europe PMC collapses it; write one`);
    }
  }
  const lead = unquoted.match(/^\s*(AND|OR)\b/i);
  if (lead) faults.push(`the query starts with "${lead[1]!.toUpperCase()}" — Europe PMC discards it; remove it`);
  const tail = unquoted.match(/\b(AND|OR|NOT)\s*$/i);
  if (tail) faults.push(`the query ends with "${tail[1]!.toUpperCase()}" — Europe PMC discards it; remove it`);
  return faults;
}

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
  /** ";"-separated publication-type list ("retracted publication; editorial").
   *  The retraction marker rides here on the compact (lite) form. */
  pubType?: string;
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
  // ── Core-only fields (resultType=core; the lite form omits them) ──
  /** The publication-type list ("Journal Article", "Preprint", "Retracted
   *  Publication", …). The lite form carries the ";"-separated `pubType`
   *  string instead. */
  pubTypeList?: { pubType?: string[] } | null;
  /** Every author with the full affiliation list — all institutions of a
   *  multi-affiliated author, not just the corresponding author's. */
  authorList?: {
    author?: Array<{
      fullName?: string;
      authorAffiliationDetailsList?: { authorAffiliation?: Array<{ affiliation?: string }> } | null;
    }>;
  } | null;
  /** The record's identifiers, ORCIDs included. Aggregate — the wire does not
   *  link an identifier to a specific author. */
  authorIdList?: { authorId?: Array<{ type?: string; value?: string }> } | null;
  /** Comments and corrections; a retraction notice rides here. */
  commentCorrectionList?: {
    commentCorrection?: Array<{ type?: string; source?: string; id?: string; reference?: string }>;
  } | null;
  /** Ranked full-text copies the backend offers. */
  fullTextUrlList?: {
    fullTextUrl?: Array<{ site?: string; url?: string; availability?: string }>;
  } | null;
  /** Abstract body — the lite form omits it. */
  abstractText?: string;
  /** Three-letter language code. */
  language?: string;
  /** "ppublish" | "epublish" | "aheadofprint" | …. */
  publicationStatus?: string;
  /** Evidence-availability flags, "Y"/"N". */
  hasData?: string;
  hasSuppl?: string;
  hasPDF?: string;
  [key: string]: unknown;
}

export interface EuropePmcResponse {
  /** hitCount even when resultList missing — malformed-detection reads it. */
  hitCount?: number;
  resultList?: { result?: EuropePmcResult[] } | null;
  /** The citation-walk endpoints return these instead of resultList. */
  citationList?: { citation?: EuropePmcResult[] } | null;
  referenceList?: { reference?: EuropePmcResult[] } | null;
  /** The search endpoint's paging handle — present only when the request sent
   *  `cursorMark`, and absent on the last page. */
  nextCursorMark?: string;
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

/** The publication type Europe PMC stamps on a withdrawn work — the one
 *  source the marker check and the exclusion clause share. */
const RETRACTED_PUB_TYPE = "Retracted Publication";

/** The comment-correction type that names a retraction notice ("Retraction
 *  in" / "Retraction of") — the notice vocabulary, distinct from the
 *  publication-type marker above. */
const RETRACTION_NOTICE_TYPE = /retract/i;

/** The backend's own retraction-exclusion clause — a query-language condition
 *  Europe PMC evaluates server-side, so the reported count already reflects
 *  it (no post-fetch removal). Pure; exported for tests. */
export const RETRACTION_EXCLUSION_CLAUSE = `NOT PUB_TYPE:"${RETRACTED_PUB_TYPE}"`;

/** Does this record's publication-type list mark it retracted? pubType is a
 *  ";"-separated list ("retracted publication; editorial"); absent means the
 *  API didn't say, which is not a retraction. Pure; exported for tests. */
export function isRetractedPubType(pubType: string | undefined): boolean {
  if (typeof pubType !== "string" || pubType === "") return false;
  return pubType
    .split(";")
    .some((t) => t.trim().toLowerCase() === RETRACTED_PUB_TYPE.toLowerCase());
}

/** Fold the plugin's retraction-exclusion clause into the agent's query — the
 *  same merge rule the OpenAlex adapter uses: append only when the clause is
 *  not already present, never rewrite, reorder, or drop the agent's own
 *  clauses. A query that already carries any `PUB_TYPE:"Retracted
 *  Publication"` condition (either polarity — an agent that asked FOR
 *  retracted works must not be contradicted) is left untouched. Opt in with
 *  `includeRetracted: true`. Pure; exported for tests. */
export function mergeRetractionClause(query: string, includeRetracted?: boolean): string {
  if (includeRetracted === true) return query;
  if (/PUB_TYPE\s*:\s*["']?retracted publication["']?/i.test(query)) return query;
  const trimmed = query.trim();
  return trimmed === "" ? RETRACTION_EXCLUSION_CLAUSE : `${trimmed} AND ${RETRACTION_EXCLUSION_CLAUSE}`;
}

/** A record's publication types from either wire shape: the core
 *  `pubTypeList.pubType[]`, or the lite/walk `pubType` ";"-separated string.
 *  Pure; exported for tests. */
export function pubTypes(r: EuropePmcResult): string[] {
  const list = r.pubTypeList?.pubType;
  if (Array.isArray(list) && list.length > 0) {
    return list.filter((t): t is string => typeof t === "string" && t !== "");
  }
  return typeof r.pubType === "string" && r.pubType !== ""
    ? r.pubType.split(";").map((t) => t.trim()).filter(Boolean)
    : [];
}

/** The primary work type — the first publication type that is not the
 *  retraction marker, which `retracted` carries on its own. Pure. */
export function primaryPubType(types: string[]): string | undefined {
  return types.find((t) => !isRetractedPubType(t)) ?? types[0];
}

/** The record's affiliations, deduped in authorship order, from every author's
 *  full affiliation list — a dual-affiliated author contributes both. The flat
 *  corresponding-author `affiliation` is the fallback when the wire sends no
 *  author list. Pure; exported for tests. */
export function parseAffiliations(r: EuropePmcResult): PaperInstitution[] | undefined {
  const seen = new Set<string>();
  const out: PaperInstitution[] = [];
  const authors = Array.isArray(r.authorList?.author) ? r.authorList.author : [];
  for (const a of authors) {
    const affiliations = Array.isArray(a?.authorAffiliationDetailsList?.authorAffiliation)
      ? a.authorAffiliationDetailsList.authorAffiliation
      : [];
    for (const aff of affiliations) {
      const name = typeof aff?.affiliation === "string" ? aff.affiliation.trim() : "";
      if (name === "") continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name });
    }
  }
  if (out.length === 0 && typeof r.affiliation === "string" && r.affiliation.trim() !== "") {
    out.push({ name: r.affiliation.trim() });
  }
  return out.length > 0 ? out : undefined;
}

/** The record's ORCID identifiers, deduped. The wire carries them as an
 *  aggregate list, not linked to individual authors. Pure; exported. */
export function parseOrcids(r: EuropePmcResult): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  const ids = Array.isArray(r.authorIdList?.authorId) ? r.authorIdList.authorId : [];
  for (const id of ids) {
    if (typeof id?.type !== "string" || id.type.toUpperCase() !== "ORCID") continue;
    const value = typeof id?.value === "string" ? id.value.trim() : "";
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

/** The venue's kind in the shared vocabulary: "repository" for a preprint
 *  server (source PPR, or a Preprint publication type), "journal" when the
 *  record names a journal, absent when the wire says neither. Pure. */
export function europePmcVenueType(r: EuropePmcResult, types: string[]): string | undefined {
  if (r.source === "PPR" || types.some((t) => /preprint/i.test(t))) return "repository";
  if (r.journalInfo?.journal?.title ?? r.journalTitle ?? r.journalAbbreviation) return "journal";
  return undefined;
}

/** The retraction notice a retracted record points at: the Europe PMC page for
 *  the notice when the wire carries its source+id, else a DOI lifted from the
 *  reference string, else nothing. Pure; exported. */
export function retractionNoticeUrl(r: EuropePmcResult): string | undefined {
  const corrections = Array.isArray(r.commentCorrectionList?.commentCorrection)
    ? r.commentCorrectionList.commentCorrection
    : [];
  const notice = corrections.find(
    (c) => typeof c?.type === "string" && RETRACTION_NOTICE_TYPE.test(c.type),
  );
  if (!notice) return undefined;
  if (notice.source && notice.id) return `https://europepmc.org/article/${notice.source}/${notice.id}`;
  // The reference is a citation string ("J Psychosoc Nurs. doi: 10.3928/…-01."),
  // so the DOI match takes trailing sentence punctuation with it unless it is
  // trimmed.
  const doi = typeof notice.reference === "string"
    ? notice.reference.match(/10\.\d{4,}\S+/)?.[0].replace(/[.,;)]+$/, "")
    : undefined;
  return doi ? `https://doi.org/${doi}` : undefined;
}

/** Evidence-availability markers the backend reports. Pure; exported. */
export function parseDataAvailability(r: EuropePmcResult): string[] | undefined {
  const out: string[] = [];
  if (isFlagY(r.hasData)) out.push("data");
  if (isFlagY(r.hasSuppl)) out.push("supplementary");
  if (isFlagY(r.hasPDF)) out.push("pdf");
  return out.length > 0 ? out : undefined;
}

/** Ranked full-text copies the backend offers. Pure; exported. */
export function parseFullTextUrls(
  r: EuropePmcResult,
): PaperFullTextUrl[] | undefined {
  const out: PaperFullTextUrl[] = [];
  const urls = Array.isArray(r.fullTextUrlList?.fullTextUrl) ? r.fullTextUrlList.fullTextUrl : [];
  for (const u of urls) {
    if (typeof u?.site !== "string" || u.site === "" || typeof u?.url !== "string" || u.url === "") continue;
    out.push({ site: u.site, url: u.url, ...(typeof u.availability === "string" ? { availability: u.availability } : {}) });
  }
  return out.length > 0 ? out : undefined;
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
    const types = pubTypes(r);
    const retracted = types.some((t) => isRetractedPubType(t));
    const venue = r.journalInfo?.journal?.title ?? r.journalTitle ?? r.journalAbbreviation;
    const rec: PaperRecord = {
      title: r.title ?? "",
      url,
      snippet: buildPaperSnippet({
        venue,
        year: parsePubYear(r.pubYear),
        citedBy: r.citedByCount,
        authors: parseAuthors(r.authorString),
        retracted: retracted ? true : undefined,
        oaToken: isFlagY(r.isOpenAccess) ? "open" : "closed",
      }),
    };
    const year = parsePubYear(r.pubYear);
    if (year !== undefined) rec.year = year;
    const authors = parseAuthors(r.authorString);
    if (authors) rec.authors = authors;
    if (venue) rec.venue = venue;
    if (r.citedByCount !== undefined) rec.citedBy = r.citedByCount;
    const oaUrl = chooseOaUrl(r);
    if (oaUrl) rec.oaUrl = oaUrl;
    if (r.doi) rec.doi = r.doi;
    if (retracted) rec.retracted = true;
    // Authority: every author's affiliations, the work type, the preprint
    // source, the ORCIDs, and the retraction notice where one exists.
    const type = primaryPubType(types);
    if (type) rec.type = type;
    const venueType = europePmcVenueType(r, types);
    if (venueType) rec.venueType = venueType;
    const institutions = parseAffiliations(r);
    if (institutions) rec.institutions = institutions;
    const orcids = parseOrcids(r);
    if (orcids) rec.orcids = orcids;
    const notice = retracted ? retractionNoticeUrl(r) : undefined;
    if (notice) rec.retractionNotice = notice;
    // Branch-narrow fields: carried on every record, printed only on a
    // single-record page (see renderPaperExtras).
    if (r.abstractText) rec.content = elide(r.abstractText, ABSTRACT_MAX);
    if (r.language) rec.language = r.language;
    if (r.publicationStatus) rec.publicationStatus = r.publicationStatus;
    const availability = parseDataAvailability(r);
    if (availability) rec.dataAvailability = availability;
    const fullText = parseFullTextUrls(r);
    if (fullText) rec.fullTextUrls = fullText;
    records.push(rec);
  }
  return records;
}

// ── Pure seam: request params ────────────────────────────────────────────────

/** Build the Europe PMC request params: query + format + pageSize, plus the
 *  paging mechanism the endpoint actually serves, the synonym-recall lever,
 *  and the backend's own `sort`. `paging.page` is the walk endpoints' own
 *  offset (1-based, verified live: offset = (page-1)*pageSize, and
 *  pageSize=1000 serves while 1001 answers 200 with zero rows);
 *  `paging.cursor` is the search endpoint's `cursorMark`, where `*` opens the
 *  enumeration. `options.synonym` sets `synonym=true`; `options.sort` is an
 *  already-mapped Europe PMC value (see EUROPEPMC_SORTS). Pure; exported for
 *  tests. */
export function buildEuropePmcParams(
  query: string,
  numResults: number,
  paging: { page?: number; cursor?: string } = {},
  options: { synonym?: boolean; sort?: string; resultType?: string } = {},
): URLSearchParams {
  const params = new URLSearchParams({
    format: "json",
    pageSize: String(numResults),
  });
  if (query) params.set("query", query);
  if (paging.page !== undefined) params.set("page", String(paging.page));
  if (paging.cursor !== undefined) params.set("cursorMark", paging.cursor);
  // The two recall/ordering levers the backend evaluates across the whole set.
  if (options.synonym === true) params.set("synonym", "true");
  if (options.sort !== undefined) params.set("sort", options.sort);
  // `core` is the full record — affiliations, ORCIDs, work types, language,
  // abstract, full-text copies. The default `lite` omits them.
  if (options.resultType !== undefined) params.set("resultType", options.resultType);
  return params;
}

// ── Pure seam: filters ───────────────────────────────────────────────────────

/** Europe PMC filters ride INSIDE the query string (field syntax), unlike
 *  OpenAlex's separate filter param. Year exact: PUB_YEAR:"2023"; range:
 *  (PUB_YEAR:[2019 TO 2021]); OA: OPEN_ACCESS:y; retracted work is excluded by
 *  default through the backend's own PUB_TYPE clause (PIWEB-35), folded into
 *  the agent's query rather than replacing it — all verified live. Pure;
 *  exported for tests. */
export function buildEuropePmcFilterQuery(query: string, filters?: PaperFilters): string {
  const base = mergeRetractionClause(query, filters?.includeRetracted);
  const conds: string[] = [];
  if (filters?.year !== undefined) conds.push(`PUB_YEAR:"${filters.year}"`);
  if (filters?.yearRange) conds.push(`(PUB_YEAR:[${filters.yearRange[0]} TO ${filters.yearRange[1]}])`);
  if (filters?.openAccess === true) conds.push("OPEN_ACCESS:y");
  if (conds.length === 0) return base;
  return base ? `${base} AND ${conds.join(" AND ")}` : conds.join(" AND ");
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
): Promise<PaperPage> {
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
  // The walk endpoints are true offset paging: the shared `page` is theirs,
  // and `numResults` rides as their pageSize.
  const body = await fetchShaped(() => deps.fetchRoute(
    path,
    buildEuropePmcParams("", n, { page: options.page }),
    options.signal,
  ));
  const raw = body.citationList?.citation ?? body.referenceList?.reference ?? [];
  const records = applySort(applyYearFilter(normalizeEuropePmcResults(raw), options.filters), options.filters);
  if (records.length === 0) {
    throw new PaperError(paperError("no-results", "europepmc"));
  }
  return paperPage(records, n, { total: body.hitCount });
}

/** Europe PMC search failure classification, shared by the search and lookup
 *  paths: 4xx (except 429) is the API rejecting the request — the
 *  malformed-query case; every other failure is the backend being down.
 *  Live behavior: Europe PMC's parser is loose (unbalanced quotes don't
 *  400), so a 400 is a genuinely rejected query, not parser fuzz. Pure;
 *  exported for tests. */
export function classifyEuropePmcFailure(err: unknown): PaperBackendStatus {
  if (err instanceof PaperError) return "no-results";
  const message = err instanceof Error ? err.message : String(err);
  return /returned 4\d\d/.test(message) && !/returned 429/.test(message)
    ? "malformed"
    : "backend-down";
}

/** Search the papers vertical's Europe PMC backend. Throws PaperError whose
 *  message IS the in-band error text — named backend, retry hint, status
 *  distinction — so the entry passes it through verbatim. Returns a page:
 *  the records plus the search endpoint's `nextCursorMark` when it serves
 *  one, so an enumeration continues from one call's handle. */
export async function searchEuropePmc(
  query: string,
  options: SearchOptions = {},
  deps: EuropePmcDeps = defaultEuropePmcDeps,
): Promise<PaperPage> {
  // The expression door is the works adapter's filter language — this adapter
  // cannot read it. Ignoring it would drop the agent's constraints silently,
  // so the adapter declines and names where each constraint goes instead:
  // Europe PMC's own query language, with the identifier form spelled out
  // because that is where a single-record lookup retires to here.
  if (options.filters?.expression !== undefined) {
    throw new PaperError(paperError("malformed", "europepmc",
      "filters.expression is OpenAlex's filter list — write the constraint into the query instead, e.g. PUB_YEAR:\"2020\", OPEN_ACCESS:y, SRC:MED; an identifier goes there too, e.g. DOI:\"10.…\", EXT_ID:22955618, PMCID:PMC…"));
  }
  // A sort key outside the accepted set is declined before it is sent: the
  // backend answers an invalid sort with a 503, which reads as an outage.
  const sortValue = options.filters?.sort === undefined
    ? undefined
    : europePmcSortValue(options.filters.sort);
  if (options.filters?.sort !== undefined && sortValue === null) {
    throw new PaperError(paperError("malformed", "europepmc",
      `unrecognised sort ${JSON.stringify(options.filters.sort)} — accepted: ${EUROPEPMC_SORTS.map((s) => s.key).join(", ")}. Europe PMC answers an invalid sort as a 503 outage-lookalike, so it is never sent`,
      null));
  }
  const n = options.numResults ?? DEFAULT_PAGE_SIZE;
  const graph = options.filters?.citationGraph;
  if (graph) {
    // The two enumeration surfaces are declared honestly rather than unified:
    // a walk is offset-paged, so a cursor is not its mechanism. The walk also
    // takes no query, so the synonym lever has nothing to expand.
    if (options.filters?.cursor !== undefined) {
      throw new PaperError(paperError("malformed", "europepmc",
        "a Europe PMC citation walk is offset-paged — pass `page` for the page number and numResults for the page size; filters.cursor serves the search endpoint",
        null));
    }
    if (options.filters?.synonym === true) {
      throw new PaperError(paperError("malformed", "europepmc",
        "filters.synonym expands a free-text query — a citation walk has none; pass it on a search instead",
        null));
    }
    return searchEuropePmcWalk(graph, n, options, deps);
  }
  // The search endpoint pages by cursor and ignores `page` outright — verified
  // live: page=2 returns page 1's ids with no error. Those ids would be a
  // silent duplicate page, so the request is declined and the mechanism named.
  if (options.page !== undefined) {
    throw new PaperError(paperError("malformed", "europepmc",
      "Europe PMC's search endpoint pages by cursor, not page number — pass filters.cursor: \"*\" to open the enumeration, then each response's Next cursor to continue it",
      null));
  }
  // The query language is loose on the wire: an unrecognised field prefix, an
  // unclosed quote or parenthesis, a doubled or dangling conjunction, an empty
  // pair of parentheses — Europe PMC returns no error for any of them, so a
  // repaired query would answer a question the agent did not ask. Each is
  // declined here with its own cause, and the fix is local (no retry index).
  const faults = europePmcQueryFaults(query);
  if (faults.length > 0) {
    throw new PaperError(paperError("malformed", "europepmc", faults.join("; "), null));
  }
  const params = buildEuropePmcParams(buildEuropePmcFilterQuery(query, options.filters), n, {
    cursor: options.filters?.cursor,
  }, {
    synonym: options.filters?.synonym,
    sort: sortValue ?? undefined,
    resultType: "core",
  });
  let body: EuropePmcResponse;
  try {
    body = await deps.fetchResults(params, options.signal);
  } catch (err) {
    if (err instanceof PaperError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PaperError(paperError(classifyEuropePmcFailure(err), "europepmc", message));
  }
  const results = normalizeEuropePmcResults(body.resultList?.result ?? []);
  if (results.length === 0) {
    throw new PaperError(paperError("no-results", "europepmc"));
  }
  // Europe PMC ships `nextCursorMark` on every search response, cursor mode or
  // not (verified live 2026-09-30) — so the handle is attached only when the
  // request opened or continued an enumeration. Attaching it always would
  // print a Next cursor line on every ordinary search and, because a
  // cursor-bearing response is never cached, quietly cost the search cache.
  return paperPage(results, n, {
    nextCursor: options.filters?.cursor !== undefined ? body.nextCursorMark : undefined,
    total: body.hitCount,
  });
}

/** The index name this adapter serves — attached to the adapter's export so
 *  the dispatcher's record keeps a single source of truth. */
export const EUROPEPMC_INDEX: PaperIndexName = "europepmc";
