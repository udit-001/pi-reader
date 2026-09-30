// paper-backend.ts — the shared record seam for the papers vertical.
//
// With two real backends (OpenAlex, Europe PMC via `search/`) the flat record
// shape, the display snippet, and the in-band error contract live in a module
// neither backend owns — otherwise one backend's quirks leak into the other's
// output and every row reads a different grammar downstream. Every backend
// normalizes into `PaperRecord` (PIWEB-14's contract, unchanged), renders
// through `buildPaperSnippet`, and reports failure through `paperError` —
// named backend, the retry `index` where rerouting can serve the request, the
// manual-URL escape hatch, and the no-results/backend-down/malformed
// distinction.
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
  /** The work's authors, in the API's order — each with the identifiers the
   *  backend carries. */
  authors?: PaperAuthor[];
  /** The hosting venue — name plus its kind and OpenAlex source id. */
  venue?: PaperVenue;
  /** Total citation count. */
  citedBy?: number;
  /** Best reachable open-access URL; absent when the work is closed. */
  oaUrl?: string;
  /** Bare DOI identifier ("10.1038/s41587-020-0561-9"), not the URL form. */
  doi?: string;
  /** Retraction flag — true when the index knows the work is retracted.
   *  Absent when the API doesn't provide the field; never invented. */
  retracted?: boolean;
  /** The work's primary topic — its name and OpenAlex topic id. */
  topic?: PaperTopic;
  /** Work type, in the backend's own vocabulary — OpenAlex's enum (article,
   *  review, preprint, …) or Europe PMC's publication-type string ("Journal
   *  Article", "Editorial", …). Absent when the API doesn't provide the
   *  field; never invented. */
  type?: string;
  /** Field-weighted citation impact — citations ÷ the median for the
 *  work's topic, publication year, and type (1.0 = exactly
 *  field-typical, 2.0 = twice; OpenAlex's definition). Reads beside
 *  `citedBy`: citedBy is absolute reach, fwci is breakout against the
 *  work's own cohort — raw counts mislead across fields, fwci doesn't.
 *  OpenAlex only. */
  fwci?: number;
  /** The work's references as bare OpenAlex W-ids, capped at 40 — the
 *  correlation atom: overlap the sets across two rows and shared
 *  foundations surface with zero extra calls. OpenAlex only. */
  refs?: string[];
  /** Algorithmically related works as bare OpenAlex W-ids, capped at 10 —
 *  a free expansion pool beyond citations. OpenAlex only. */
  related?: string[];
  /** Citations accumulated over the last 3 complete publication years. */
  recentCitations?: number;
  /** The citation trajectory over those years — "rising" means the work
 *  is still being picked up, "fading" that the citation flow has moved
 *  on. */
  citationTrend?: "rising" | "steady" | "fading";
  /** The topic hierarchy's field-level name (26 fields, e.g. "Computer
 *  Science") — the granularity a resultset cluster check runs at. */
  field?: string;
  /** Up to 3 keyword display names — literal topic tokens for
 *  presenting. */
  keywords?: string[];
  /** Bare OpenAlex W-id — the seed vocabulary for citation walks and the
 *  graph math on refs/related; never surfaced in the snippet. */
  openalexId?: string;
  /** The source-scoped record identity, Europe PMC's own `id`/`source` pair
   *  ("MED" + "42575118"). Carried on an identifiers-only row, where the pair
   *  is the row's whole payload; absent otherwise, where the DOI and the URL
   *  already identify the work. */
  europepmcId?: string;
  /** The index `europepmcId` belongs to: MED, PMC, PPR, PAT, AGR, or CBA. */
  europepmcSource?: string;
  /** A PubMed identifier, where the record is a MED record. An ids-only row
   *  carries whichever of this and `pmcid` the wire sent — the identifier the
   *  lookup forms take. Absent on a source that has none. */
  pmid?: string;
  /** A PubMed Central identifier, where the record is a PMC record. */
  pmcid?: string;
  /** The work's institutions, one entry per institution in authorship order
   *  (a dual-affiliated author and a co-author at the same lab collapse to
   *  one) — the provenance signal: a company lab reads differently from a
   *  university. OpenAlex fills type/country/ROR per entry; Europe PMC
   *  supplies the author affiliation string as the name. */
  institutions?: PaperInstitution[];
  /** How many references the work lists — a bibliography of hundreds reads
   *  differently from a footnote of five, and `refs` is capped at 40.
   *  OpenAlex only. */
  refCount?: number;
  /** The record's ORCID identifiers, where the backend provides them. Europe
   *  PMC carries an aggregate list, so these are not linked to a specific
   *  author. Absent when the wire names none. */
  orcids?: string[];
  /** Link to the retraction notice a retracted record points at. Europe PMC
   *  only; absent when the wire carries no notice. */
  retractionNotice?: string;
  /** Three-letter language code ("eng"). Europe PMC only. */
  language?: string;
  /** Publication status — "ppublish", "epublish", "aheadofprint", ….
   *  Europe PMC only. */
  publicationStatus?: string;
  /** Evidence-availability markers the backend reports ("data",
   *  "supplementary", "pdf"). Europe PMC only. */
  dataAvailability?: string[];
  /** Ranked full-text copies the backend offers — the read-the-paper branch
   *  picks from these, and the record's own `url` is chosen from their free
   *  half. Europe PMC only. */
  fullTextUrls?: PaperFullTextUrl[];
  /** Subject tags from the backend's controlled vocabulary, in wire order —
   *  the curated counterpart of `topic`/`field`, which one adapter's
   *  algorithmic topic model fills. Europe PMC's MeSH headings. */
  subjects?: PaperSubject[];
  /** The compounds the work studies, with registry numbers. Europe PMC
   *  only. */
  compounds?: PaperCompound[];
  /** The agencies and grants behind the work. Europe PMC only. */
  funding?: PaperGrant[];
}

/** One subject tag from a controlled vocabulary, with the vocabulary's own
 *  major-topic flag — the reading-order question is "is this on my topic",
 *  and a starred term answers it without the agent knowing the vocabulary's
 *  conventions. */
export interface PaperSubject {
  term: string;
  /** The paper is *about* this term rather than merely indexed under it.
   *  Absent when the wire carries no flag; never invented. */
  major?: boolean;
}

/** One compound a work studies. The registry number is absent-tolerant: a
 *  backend that carries none leaves the key off rather than shipping its own
 *  sentinel. */
export interface PaperCompound {
  name: string;
  /** The registry number (CAS) the backend carries, e.g. "7440-57-5". */
  registry?: string;
}

/** One funding grant. Agency is the anchor; a grant may carry neither an
 *  identifier nor an acronym, and an absent key is never invented. */
export interface PaperGrant {
  agency: string;
  grantId?: string;
  acronym?: string;
}

/** One full-text copy a backend offers, ranked by the backend. */
export interface PaperFullTextUrl {
  site: string;
  url: string;
  availability?: string;
}

/** One author on a work — the name plus the identifiers the backend carries.
 *  OpenAlex fills id and orcid; Europe PMC's wire carries no per-author
 *  identifier, so both stay absent there. Never invented. */
export interface PaperAuthor {
  name: string;
  /** Bare OpenAlex author id ("A5035249241"). OpenAlex only. */
  id?: string;
  /** Bare ORCID ("0000-0002-1825-0097"). OpenAlex only. */
  orcid?: string;
}

/** One institution a work's authors claim. Every key but the name is
 *  absent-tolerant — the API leaves id, type, country, and ROR off some
 *  records, and an absent field is never invented. */
export interface PaperInstitution {
  name: string;
  /** Bare OpenAlex institution id ("I4210129232"). OpenAlex only. */
  id?: string;
  /** education | company | government | healthcare | nonprofit | facility |
   *  archive | other (OpenAlex's institution vocabulary). */
  type?: string;
  /** ISO 3166-1 alpha-2 country code of the institution, not the author. */
  country?: string;
  /** Bare ROR identifier ("05a0ya142"), not the ror.org URL form. */
  ror?: string;
}

/** The hosting venue — its name plus the identity and kind the backend
 *  carries. OpenAlex fills type ("journal", "repository", …) and the bare
 *  source id; Europe PMC fills the name and the type it derives. Every key
 *  but the name is absent-tolerant. */
export interface PaperVenue {
  /** The venue's name; absent when the wire names none — a bare preprint
   *  source still contributes its kind. */
  name?: string;
  /** journal | repository | conference | ebook platform | book series |
   *  book. Tells a peer-reviewed venue from a preprint server. */
  type?: string;
  /** Bare OpenAlex source id ("S106963461"). OpenAlex only. */
  id?: string;
}

/** The work's primary topic — its name and the OpenAlex topic id the filter
 *  vocabulary and the hierarchy read from. OpenAlex only beyond the name. */
export interface PaperTopic {
  name: string;
  /** Bare OpenAlex topic id ("T10878"). OpenAlex only. */
  id?: string;
}
// The work's abstract rides the inherited `content` key (truncated to
// ~300 chars by the OpenAlex normalizer) — the on-topic judgment is the
// one thing tokens can't carry, and content is already rendered by the
// entry's body-preview branch.

/** Structural probe: does this result carry the flat paper keys? Used by the
 *  entry to render paper fields on generic SearchResult rows. Pure; exported
 *  for tests. */
export function isPaperRecord(r: SearchResult): r is PaperRecord {
  return "year" in r || "venue" in r || "citedBy" in r || "oaUrl" in r || "doi" in r
    || "retracted" in r || "topic" in r || "type" in r
    || "fwci" in r || "refs" in r || "related" in r || "field" in r
    || "openalexId" in r || "keywords" in r || "citationTrend" in r
    || "institutions" in r || "refCount" in r
    || "subjects" in r || "compounds" in r || "funding" in r
    || "europepmcId" in r || "europepmcSource" in r || "pmid" in r || "pmcid" in r
    || Array.isArray((r as PaperRecord).authors);
}

/** Every backend paged at the same size; the entry's default (10/15) and
 *  tests all agree on the width. */
export const DEFAULT_PAGE_SIZE = 10;

// ── Pure seam: snippet ────────────────────────────────────────────────────────

// ── PaperPage — the papers module's return contract ──────────────────────────

/** One page of a papers call: the records, the cursor for the next page
 *  when the adapter serves one, and the index's own match count when it
 *  reported one. Returned instead of a bare array so the page boundary and
 *  the size of the set behind it are part of the interface — the entry
 *  renders both, and no adapter has to smuggle either out of band. */
export interface PaperPage {
  results: PaperRecord[];
  /** Opaque cursor for the next page; absent when the result set is
   *  exhausted or the adapter has no cursor. */
  nextCursor?: string;
  /** How many works the adapter reported matching this request. It is the
   *  adapter's own number rather than a recount of what the caller's filters
   *  left: a server-side filter (the retraction default) is already applied to
   *  it, while one an adapter binds post-fetch — the Europe PMC walk's year
   *  window — is not. Absent when the adapter reported none. */
  total?: number;
}

/** Everything the shared page assembler needs beyond the rows themselves:
 *  the next-page handle and the index's count, either of which a given
 *  adapter may not have to give. */
export interface PaperPageMeta {
  nextCursor?: string | null;
  total?: number;
}

/** One page of results: the records sliced to the caller's page size, plus
 *  the adapter's own handle for the next page and match count when it served
 *  them. Both backends return their page through this, so the page boundary
 *  and the set size are part of the module's contract rather than a
 *  per-adapter detail. An empty or absent handle leaves `nextCursor` off the
 *  page — never an empty string; a count that is not a finite number leaves
 *  `total` off — never a NaN. Pure; exported for tests. */
export function paperPage(results: PaperRecord[], limit: number, meta: PaperPageMeta = {}): PaperPage {
  const page: PaperPage = { results: results.slice(0, limit) };
  const { nextCursor, total } = meta;
  if (typeof nextCursor === "string" && nextCursor !== "") page.nextCursor = nextCursor;
  if (typeof total === "number" && Number.isFinite(total)) page.total = total;
  return page;
}

/** The per-record snippet inputs, whatever backend produced them. Each field
 *  absent tolerated — the builder never invents a token. */
export interface PaperSnippetMeta {
  venue?: string;
  year?: number;
  citedBy?: number;
  /** The work's authors, in the API's order; only the first (plus count)
   *  reaches the snippet. */
  authors?: PaperAuthor[];
  /** Open-access badge the backend already classified ("closed", "green",
   *  "open"); absent → no token. */
  oaToken?: string;
  /** Retraction flag — true renders the retracted badge, which takes
   *  precedence in reading order: a retraction changes how every other token
   *  is weighed. */
  retracted?: boolean;
  /** Primary topic display name; absent → no token. */
  topic?: string;
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
  // The retracted badge precedes the OA badge — a retraction changes how
  // every token after it should be weighed.
  if (meta.retracted === true) tokens.push("retracted");
  if (meta.oaToken) tokens.push(meta.oaToken);
  if (meta.topic) tokens.push(meta.topic);
  const first = meta.authors?.[0]?.name;
  if (first !== undefined) {
    tokens.push((meta.authors?.length ?? 1) === 1 ? first : `${first} et al.`);
  }
  return tokens.join(" · ");
}

// ── Pure seam: record URL choice ─────────────────────────────────────────────

/** The record's `url` is the canonical place the agent acts on — the link a
 *  human clicks and the fetch chain resolves. doi.org is a poor default for
 *  it: the resolution hop rate-limits under volume (429s bite when an agent
 *  walks a result set), and where it lands is the most bot-walled corner of
 *  publishing (Cloudflare challenges, auth transit pages). Every backend
 *  carries copies that fetch cleanly — PMC full text, DOAJ, repository and
 *  publisher pages — so the policy ranks candidates by fetchability:
 *
 *    4  PMC full-text copies (ncbi.nlm.nih.gov/pmc/, europepmc.org/article/PMC…)
 *    3  any other publisher/repository/preprint page
 *    2  doi.org resolution
 *    1  bare metadata records (openalex.org/W…, europepmc.org/article/MED…)
 *
 *  Ties break by candidate order — backends pass their own preference first.
 *  Closed works with doi.org as the only candidate keep it; the bare DOI
 *  always rides the record's `doi` key, so a copy-URL never costs citation
 *  seeds. Shared by every backend — one URL policy, wherever the record came
 *  from. Pure; exported for tests. */
export function chooseFetchableUrl(candidates: Array<string | null | undefined>): string | null {
  const rank = (u: string): number => {
    if (/^https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\//i.test(u)) return 4;
    if (/^https?:\/\/europepmc\.org\/article\/PMC/i.test(u)) return 4;
    if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(u)) return 2;
    // Metadata record views — the record's provenance, not the paper.
    if (/^https?:\/\/europepmc\.org\/article\/(?!PMC)/i.test(u)) return 1;
    if (/^https?:\/\/openalex\.org\//i.test(u)) return 1;
    return 3;
  };
  let best: string | null = null;
  let bestRank = -1;
  for (const c of candidates) {
    if (typeof c !== "string" || !/^https?:\/\//i.test(c)) continue;
    const r = rank(c);
    if (r > bestRank) {
      best = c;
      bestRank = r;
    }
  }
  return best;
}

// ── Filters + citation traversal (PIWEB-16) ───────────────────────────────

/** The orderings the interface offers, each with the condition that earns it.
 *  One table: the always-loaded description is composed from it in the entry,
 *  and each adapter maps the keys it serves — so a key cannot be documented
 *  without being served, or served without being documented. The type is
 *  derived from the keys, so the vocabulary and the table are one thing rather
 *  than two that can drift.
 *
 *  `fwci` is the one ordering not every adapter serves: Europe PMC computes no
 *  field-normalized impact, so it declines that key in band rather than
 *  answering it with a different ordering. */
export const PAPER_SORTS = [
  { key: "citedBy", condition: "descending citation count — the 'find papers on X which are highly cited' ask" },
  { key: "date", condition: "newest first" },
  { key: "fwci", condition: "descending field-normalized impact — the 'breakout in its own field' ask" },
] as const;

export type PaperSort = (typeof PAPER_SORTS)[number]["key"];

/** The matchers the interface offers for the free-text query, each with the
 *  condition that earns it. One table: the always-loaded description is
 *  composed from it in the entry, and each adapter maps the keys it serves — so
 *  a key cannot be documented without being served, or served without being
 *  documented. The type is derived from the keys, so the vocabulary and the
 *  table are one thing.
 *
 *  The default — OpenAlex's stemmed keyword search — is deliberately absent: it
 *  is the absence of the parameter, and a value for it would be a no-op the
 *  agent has to learn. The description names it in prose instead. */
export const PAPER_SEARCH_MODES = [
  { key: "exact", condition: "matches literally and unstemmed — the mode wildcards (`*`, `?`) require" },
  { key: "semantic", condition: "matches by meaning from an embedding — give it a paragraph, not a word or two; caps at 50 results" },
] as const;

export type PaperSearchMode = (typeof PAPER_SEARCH_MODES)[number]["key"];

/** The abstract's record-side cap — the on-topic judgment fits in a screen,
 *  and a list row pays context per result. */
export const ABSTRACT_MAX = 300;

/** Truncate to `max` characters with a visible ellipsis — the one place that
 *  decides what a cut-off looks like, so an abstract preview and a backend's
 *  complaint read the same way. Pure; exported for tests. */
export function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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
  /** Order results away from relevance. `"citedBy"` is descending citation
   *  count (the "highly cited" ask), `"date"` is newest-first. Both adapters
   *  ask the backend to sort the whole set, not the fetched page: OpenAlex
   *  maps to `cited_by_count:desc` / `publication_date:desc`, Europe PMC to
   *  `CITED desc` / `P_PDATE_D desc` through EUROPEPMC_SORTS. A Europe PMC
   *  citation walk is the one exception — its routes take no sort, so the
   *  ordering applies to the page the endpoint returns (see applySort). */
  sort?: PaperSort;
  /** Which matcher the free-text `query` uses, away from the default stemmed
   *  keyword search — `exact` for literal text and the wildcards only it
   *  accepts, `semantic` for a paragraph that should match by meaning. OpenAlex
   *  only: Europe PMC has no such switch and declines it in band. Rides the
   *  cache key like every other filter, or a semantic call and a keyword call
   *  with the same query would answer from each other's entry. */
  searchMode?: PaperSearchMode;
  /** Europe PMC only: expand the query with the backend's synonym table —
   *  "heart attack" also reaches "myocardial infarction". Multiplies recall
   *  (verified live: 54,785 → 755,190 on a quoted phrase) and costs precision,
   *  so it is opt-in. The works adapter has no synonym expansion and declines
   *  it in band. */
  synonym?: boolean;
  /** Europe PMC only: request the identifiers-only enumeration tier — each
   *  match comes back as its source-scoped identifiers and nothing else, so
   *  enumerating a large set costs a fraction of a full-record page. The rows
   *  still carry a `url` derived from the pair, which is what makes each one
   *  actionable. The tier belongs to the search endpoint alone: Europe PMC's
   *  /references and /citations routes ignore `resultType` and return full
   *  entries, so a citation walk declines this in band, and OpenAlex has no such
   *  mode and declines it too. */
  idsOnly?: boolean;
  /** Opaque cursor for the OpenAlex works endpoint — the `meta.next_cursor`
   *  one call hands back, passed unmodified to the next to enumerate a
   *  result set to its end (the works adapter's own capability; other
   *  adapters decline it in band). One call is one request: the interface
   *  never follows the cursor itself. */
  cursor?: string;
  /** The agent's own OpenAlex filter list, in the API's grammar — the
   *  `filters.expression` schema description in index.ts is the operator and
   *  family reference. This is the way to any constraint the dedicated filters
   *  do not carry, to a citation query across several papers in one request
   *  (`cites:W1|W2|W3`), and to a single work by identifier (`doi:10.…`,
   *  `ids.pmid:…`). It IS the filter list, so
   *  `year`/`yearRange`/`openAccess`/`citationGraph` passed beside it are
   *  refused in band with the destination named — never appended into a silent
   *  intersect. The retraction clause is the one clause the plugin adds itself.
   *  OpenAlex only — Europe PMC's query language is different and it declines
   *  this in band, naming the identifier form its own query accepts. */
  expression?: string;
  /** Citation traversal: "cites" (default) — works that cite the paper;
   *  "citedBy" — the paper's own references. It replaces the free-text query.
   *  Each adapter serves it its own way: the works adapter composes
   *  `cites:`/`cited_by:` into the filter expression it sends, the biomedical
   *  adapter through its /citations and /references endpoints, because the
   *  expression is declined there and its query language has no citation
   *  operator to offer instead. */
  citationGraph?: PaperCitationGraph;
  /** Retracted works: excluded by default on both backends through each
   *  adapter's own server-side filter — OpenAlex's `is_retracted:false`,
   *  Europe PMC's `NOT PUB_TYPE:"Retracted Publication"` clause folded into
   *  the query — because a retraction disqualifies the work as a reading
   *  candidate. Set true to include them; the `retracted` key marks them
   *  in-band when the backend reports the marker. */
  includeRetracted?: boolean;
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

/** Order results away from relevance for the one surface whose endpoint
 *  cannot: Europe PMC's citation-walk routes take no sort (verified live — a
 *  `sort` sent there is ignored). Records without a count or year keep their
 *  order (stable sort) rather than being dropped.
 *
 *  It orders only the keys a walk's records can carry, and `fwci` is not one —
 *  no such metric reaches an EPMC record — so the adapter's decline has to keep
 *  that key from arriving here. Pure; exported for tests. */
export function applySort(records: PaperRecord[], filters?: PaperFilters): PaperRecord[] {
  if (filters?.sort === "citedBy") {
    return records.toSorted((a, b) => (b.citedBy ?? -1) - (a.citedBy ?? -1));
  }
  if (filters?.sort === "date") {
    return records.toSorted((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
  }
  return records;
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
    f.sort ?? "",
    f.searchMode ?? "",
    f.synonym === true ? "y" : "",
    f.idsOnly === true ? "ids" : "",
    f.cursor ?? "",
    f.expression ?? "",
    f.includeRetracted === true ? "y" : "",
    f.citationGraph?.seed ?? "",
    f.citationGraph?.direction ?? "",
  ];
  return parts.some((p) => p !== "") ? parts.join("|") : "";
}

/** The paper-specific row lines for the tool envelope. The subject tags print
 *  on every row, before the authority block — the topic question is asked of
 *  every result. The authority signals sit under one heading — work type,
 *  venue kind, retraction and its notice — with the affiliation set and ORCIDs
 *  beside them; the branch-narrow fields (funding, compounds, language,
 *  publication status, evidence availability, full-text copies) print only when
 *  the page is a single record, the lookup shape. Pure; exported for tests. */
export function renderPaperExtras(r: PaperRecord, single: boolean): string[] {
  const lines: string[] = [];
  const meta: string[] = [];
  if (r.year !== undefined) meta.push(`Year: ${r.year}`);
  if (r.venue?.name) meta.push(`Venue: ${r.venue.name}${r.venue.id ? ` [${r.venue.id}]` : ""}`);
  if (r.citedBy !== undefined) meta.push(r.fwci !== undefined ? `Cited by: ${r.citedBy} (fwci ${r.fwci} field-normalized)` : `Cited by: ${r.citedBy}`);
  if (r.refCount !== undefined) meta.push(`References: ${r.refCount}`);
  if (r.doi) meta.push(`DOI: ${r.doi}`);
  if (r.oaUrl) meta.push(`OA: ${r.oaUrl}`);
  if (r.topic) meta.push(`Topic: ${r.topic.name}${r.topic.id ? ` [${r.topic.id}]` : ""}`);
  if (r.field) meta.push(`Field: ${r.field}`);
  if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);

  // The subject vocabulary, above the authority block: what the work is about,
  // then what it is. Majors print first and each carries its mark, because "is
  // this on my topic" is asked of every result and a starred term is the
  // answer. Brackets, not parens — a vocabulary term can carry its own parens.
  if (r.subjects?.length) {
    const majors = r.subjects.filter((s) => s.major === true);
    const rest = r.subjects.filter((s) => s.major !== true);
    lines.push(`   Subjects: ${[
      ...majors.map((s) => `${s.term} [major]`),
      ...rest.map((s) => s.term),
    ].join(" · ")}`);
  }

  // The authority block: what the work is and who stands behind it.
  const authority: string[] = [];
  if (r.type) authority.push(`Type: ${r.type}`);
  if (r.venue?.type) authority.push(`Venue type: ${r.venue.type}`);
  if (r.retracted === true) authority.push(r.retractionNotice ? `Retracted — notice ${r.retractionNotice}` : "Retracted");
  if (authority.length > 0) lines.push(`   Authority: ${authority.join(" · ")}`);

  if (r.authors?.length) {
    lines.push(`   Authors: ${r.authors.map((a) => {
      const detail = [a.id, a.orcid ? `orcid:${a.orcid}` : undefined].filter(Boolean).join(", ");
      return detail ? `${a.name} [${detail}]` : a.name;
    }).join(", ")}`);
  }
  // The provenance set: institution type tells industry from academia, country
  // and ROR disambiguate institutions of the same name. Brackets, not parens —
  // OpenAlex's own names carry parens. Absent parts are simply not printed.
  if (r.institutions?.length) {
    lines.push(`   Institutions: ${r.institutions.map((i) => {
      const detail = [i.type, i.country, i.id, i.ror ? `ror:${i.ror}` : undefined].filter(Boolean).join(", ");
      return detail ? `${i.name} [${detail}]` : i.name;
    }).join(" · ")}`);
  }
  if (r.orcids?.length) lines.push(`   ORCIDs: ${r.orcids.join(" · ")}`);
  if (r.keywords?.length) lines.push(`   Keywords: ${r.keywords.join(", ")}`);
  if (r.recentCitations !== undefined) lines.push(`   Recent citations (last 3 complete years): ${r.recentCitations}${r.citationTrend ? ` (${r.citationTrend})` : ""}`);
  // The correlation atom, in-band: bare W-ids, each a seed for a citation
  // query in filters.expression.
  if (r.refs?.length) lines.push(`   Refs (W-ids): ${r.refs.join(", ")}`);
  if (r.related?.length) lines.push(`   Related (W-ids): ${r.related.join(", ")}`);

  // Branch-narrow: only the single-record page pays for these.
  if (single) {
    const narrow: string[] = [];
    if (r.language) narrow.push(`Language: ${r.language}`);
    if (r.publicationStatus) narrow.push(`Status: ${r.publicationStatus}`);
    if (r.dataAvailability?.length) narrow.push(`Availability: ${r.dataAvailability.join(", ")}`);
    if (narrow.length > 0) lines.push(`   ${narrow.join(" · ")}`);
    if (r.funding?.length) lines.push(`   Funding: ${r.funding.map((g) => [g.agency, g.acronym ? `[${g.acronym}]` : undefined, g.grantId].filter(Boolean).join(" ")).join(" · ")}`);
    if (r.compounds?.length) lines.push(`   Compounds: ${r.compounds.map((c) => (c.registry ? `${c.name} [${c.registry}]` : c.name)).join(" · ")}`);
    if (r.fullTextUrls?.length) lines.push(`   Full text: ${r.fullTextUrls.map((u) => `${u.site} ${u.url}`).join(" · ")}`);
  }
  return lines;
}

// ── In-band error contract ───────────────────────────────────────────────────

export type PaperBackendStatus = "no-results" | "backend-down" | "malformed";

/** What each index's search actually covers — the error guidance names the
 *  OTHER index with this scope line, so the agent can judge whether the retry
 *  fits its query instead of blind-retrying. */
const INDEX_SCOPE: Record<PaperIndexName, string> = {
  openalex: `index: "openalex" (open scholarly metadata across all disciplines)`,
  europepmc: `index: "europepmc" (biomedical full text: PubMed, PMC copies, preprints, patents)`,
};

/** `otherIndex` — the fallback `index` value the agent is told to try. Pure;
 *  exported for tests. */
export function otherIndex(index: PaperIndexName): PaperIndexName {
  return index === "openalex" ? "europepmc" : "openalex";
}

/** Build the in-band error for a failed papers search. One single home per
 *  meaning: every papers failure reads through this template, so the agent
 *  always sees the same error grammar — backend named, cause distinguished
 *  (no-results vs backend-down vs malformed), the manual URL named where one
 *  exists, and the retry `index` offered where rerouting can actually serve
 *  the request (a `malformed` clause belongs to one adapter's syntax, so its
 *  caller passes `null`). Pure; exported for tests. */
export function paperError(
  status: PaperBackendStatus,
  failedIndex: PaperIndexName,
  detail = "",
  /** The index to name as the retry — the other backend by default. `null`
   *  when rerouting cannot help (an OpenAlex-only expression the agent has to
   *  fix, not resend to an adapter that would refuse it too): the retry
   *  sentence is then dropped rather than sending the agent in a circle. */
  retryIndex: PaperIndexName | null = otherIndex(failedIndex),
): string {
  const backend = failedIndex === "openalex" ? "OpenAlex" : "Europe PMC";
  const cause = detail ? ` (${detail})` : "";
  // INDEX_SCOPE carries the other index's coverage so the agent can judge
  // whether the retry fits its query instead of blind-retrying.
  const retry = retryIndex === null ? null : INDEX_SCOPE[retryIndex];
  switch (status) {
    case "malformed":
      // The detail carries the specific complaint — the backend's own words,
      // or the interface's reason for refusing. The tail stays cause-agnostic:
      // a filter expression is made of quotes and operators, so naming syntax
      // to drop would make a working query worse.
      return `${backend} rejected the query as malformed${cause}. ` + (retry === null
        ? `Fix what the complaint names and retry.`
        : `Retry with ${retry}, or fix what the complaint names.`);
    case "backend-down":
      return `${backend} was unreachable${cause}. ` + (retry === null
        ? `Fetch a specific paper directly if you already hold its DOI or URL.`
        : `Retry with ${retry}, or fetch a specific paper directly if you already hold its DOI or URL.`);
    case "no-results":
      return `${backend} returned no results for this query${cause}. ` + (retry === null
        ? `Rephrase the query, or fetch a specific paper directly if you already hold its DOI or URL.`
        : `Retry with ${retry}, rephrase the query, or fetch a specific paper directly if you already hold its DOI or URL.`);
  }
}

/** The thrown shape so the entry can pass the message through verbatim —
 *  a generic hint rewriter would strip the named backend and the retry
 *  `index`, which IS the actionability. */
export class PaperError extends Error {}
