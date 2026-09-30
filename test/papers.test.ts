// Tests for the papers vertical — `provider: "papers"` backed by OpenAlex.
// Pure seams only: DOI parse, URL/OA choice, the papers normalizer, request
// params, and the adapter's deps flow. Fixture is a trimmed live capture
// (2026-09-25, api.openalex.org/works?search=CRISPR base editing). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDoi,
  chooseRecordUrl,
  chooseOaUrl,
  capIds,
  citationTrend,
  abstractFromInvertedIndex,
  normalizePaperResults,
  buildPaperParams,
  buildOpenAlexFilter,
  buildOpenAlexExpressionFilter,
  mergeRetractionClause,
  OPENALEX_FILTER_GRAMMAR,
  OPENALEX_FILTER_FAMILIES,
  OPENALEX_FILTER_PROBE,
  OPENALEX_SELECT,
  resolveOpenAlexKey,
  openAlexErrorDetail,
  OpenAlexHttpError,
  searchPapers,
  type OpenAlexWork,
  type OpenAlexDeps,
} from "../search/papers.ts";
import { buildPaperSnippet, chooseFetchableUrl, applySort, filtersCacheKey, paperPage, type PaperRecord } from "../search/paper-backend.ts";
import { isPaperRecord } from "../search/paper-backend.ts";
import type { SearchOptions, SearchResult } from "../search/search.ts";

// buildPaperSnippet lives in the shared paper-backend.ts — the OpenAlex
// normalizer now renders through it (one snippet shape across backends).

// ── Fixture — trimmed live capture (2026-09-25) ───────────────────────────────

// A richly-populated work: DOI, year, authors, venue, citations — closed
// access (no oa_url), landing page is the doi.org URL itself.
const NATURE_WORK: OpenAlexWork = {
  id: "https://openalex.org/W3161425918",
  doi: "https://doi.org/10.1038/s41587-020-0561-9",
  title: "Genome editing with CRISPR–Cas nucleases, base editors, transposases and prime editors",
  publication_year: 2020,
  cited_by_count: 2387,
  primary_location: {
    landing_page_url: "https://doi.org/10.1038/s41587-020-0561-9",
    source: { display_name: "Nature Biotechnology" },
  },
  open_access: { is_oa: false, oa_status: "closed", oa_url: null },
  best_oa_location: null,
  authorships: [
    { author: { display_name: "Andrew V. Anzalone" } },
    { author: { display_name: "Luke W. Koblan" } },
    { author: { display_name: "David R. Liu" } },
  ],
};

// An open-access work: pdf in best_oa_location, oa_status green.
const OA_WORK: OpenAlexWork = {
  id: "https://openalex.org/W4211394178",
  doi: "https://doi.org/10.1038/s41592-023-01898-x",
  title: "Prime editing precision and outcomes",
  publication_year: 2023,
  cited_by_count: 312,
  primary_location: {
    landing_page_url: "https://doi.org/10.1038/s41592-023-01898-x",
    source: { display_name: "Nature Methods" },
  },
  open_access: { is_oa: true, oa_status: "green", oa_url: "https://dash.harvard.edu/handle/1/37370913" },
  best_oa_location: {
    landing_page_url: "https://dash.harvard.edu/handle/1/37370913",
    pdf_url: "https://dash.harvard.edu/bitstream/1/37370913/3/manuscript.pdf",
  },
  authorships: [{ author: { display_name: "S. Qin" } }],
};

// A minimal work: only the record URL (no doi, no landing page) — the OpenAlex
// record itself is the last-resort url.
const BARE_WORK: OpenAlexWork = {
  id: "https://openalex.org/W9999999999",
  title: "A preprint with almost no metadata",
};

// ── parseDoi — URL form → bare identifier ────────────────────────────────────

test("parseDoi strips the doi.org URL form down to the bare identifier", () => {
  assert.equal(parseDoi("https://doi.org/10.1038/s41587-020-0561-9"), "10.1038/s41587-020-0561-9");
  assert.equal(parseDoi("https://doi.org/10.5281/zenodo.x"), "10.5281/zenodo.x");
});

test("parseDoi returns null for absent or non-doi.org values — never invents a DOI", () => {
  assert.equal(parseDoi(undefined), null);
  assert.equal(parseDoi("https://openalex.org/W3161425918"), null);
  assert.equal(parseDoi(""), null);
});

test("parseDoi tolerates the explicit null OpenAlex sends for works without a DOI", () => {
  // OpenAlex emits "doi": null rather than omitting the key; a null that
  // reached the .match() used to crash the whole search (TypeError, escaping
  // the in-band PaperError contract).
  assert.equal(parseDoi(null), null);
});

// ── chooseRecordUrl / chooseOaUrl — the two URL decisions ─────────────────────

test("chooseRecordUrl keeps the DOI when no more fetchable copy exists — the openalex record ranks below it", () => {
  assert.equal(chooseRecordUrl(NATURE_WORK), "https://doi.org/10.1038/s41587-020-0561-9");
  assert.equal(chooseRecordUrl({ doi: "https://doi.org/10.1/x" }), "https://doi.org/10.1/x");
  assert.equal(chooseRecordUrl({ primary_location: { landing_page_url: "https://e.com/x" } }), "https://e.com/x");
  assert.equal(chooseRecordUrl(BARE_WORK), "https://openalex.org/W9999999999");
  assert.equal(chooseRecordUrl({}), null);
});

test("chooseRecordUrl prefers a direct copy from locations over the doi.org resolution", () => {
  // The live shape from the lichen session: OpenAlex's own landing_page_url
  // is the doi.org form, but locations also carries the PMC/repo copies that
  // fetch without the doi.org hop.
  assert.equal(
    chooseRecordUrl({
      doi: "https://doi.org/10.1093/aob/mcm030",
      locations: [
        { landing_page_url: "https://doi.org/10.1093/aob/mcm030" },
        { landing_page_url: "https://pubmed.ncbi.nlm.nih.gov/17353205" },
        { landing_page_url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2802918" },
      ],
    }),
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2802918",
  );
  assert.equal(
    chooseRecordUrl({
      doi: "https://doi.org/10.1093/aob/mcm030",
      locations: [{ landing_page_url: "https://research.vu.nl/en/publications/abc" }],
    }),
    "https://research.vu.nl/en/publications/abc",
  );
});

test("chooseOaUrl picks the best_oa pdf first, then its landing page, then the top-level oa_url", () => {
  assert.equal(chooseOaUrl(OA_WORK), "https://dash.harvard.edu/bitstream/1/37370913/3/manuscript.pdf");
  assert.equal(
    chooseOaUrl({ open_access: { oa_url: "https://repo.org/1" } }),
    "https://repo.org/1",
  );
});

test("chooseOaUrl ranks a direct copy above a doi.org landing or oa_url in the same list", () => {
  assert.equal(
    chooseOaUrl({
      best_oa_location: { landing_page_url: "https://doi.org/10.1515/znc-2010-3-401" },
      open_access: { oa_url: "https://www.degruyter.com/document/doi/10.1515/znc-2010-3-401/pdf" },
    }),
    "https://www.degruyter.com/document/doi/10.1515/znc-2010-3-401/pdf",
  );
});

test("chooseOaUrl returns null for a closed work — oaUrl stays absent, never faked", () => {
  assert.equal(chooseOaUrl(NATURE_WORK), null);
  assert.equal(chooseOaUrl({}), null);
});

// ── normalizePaperResults — agent-POV normalization ───────────────────────────

test("papers normalizer maps the flat keys: year, authors, venue, citedBy, doi beside url/title/snippet", () => {
  const [r] = normalizePaperResults([NATURE_WORK]);
  assert.deepEqual(
    { title: r!.title, url: r!.url, year: r!.year, authors: r!.authors, venue: r!.venue, citedBy: r!.citedBy, doi: r!.doi },
    {
      title: "Genome editing with CRISPR–Cas nucleases, base editors, transposases and prime editors",
      url: "https://doi.org/10.1038/s41587-020-0561-9",
      year: 2020,
      authors: ["Andrew V. Anzalone", "Luke W. Koblan", "David R. Liu"],
      venue: "Nature Biotechnology",
      citedBy: 2387,
      doi: "10.1038/s41587-020-0561-9",
    },
  );
});

test("papers normalizer leaves oaUrl absent on closed works, sets it on OA works", () => {
  assert.equal("oaUrl" in normalizePaperResults([NATURE_WORK])[0]!, false);
  const [oa] = normalizePaperResults([OA_WORK]);
  assert.equal(oa!.oaUrl, "https://dash.harvard.edu/bitstream/1/37370913/3/manuscript.pdf");
});

test("papers normalizer points an OA work's row url at its copy — the bare doi stays for seeds", () => {
  const [oa] = normalizePaperResults([OA_WORK]);
  assert.equal(oa!.url, "https://dash.harvard.edu/handle/1/37370913");
  assert.equal(oa!.doi, "10.1038/s41592-023-01898-x");
});

test("papers normalizer builds the snippet from venue/year/citations/status/authors", () => {
  const [closed, oa] = normalizePaperResults([NATURE_WORK, OA_WORK]);
  assert.equal(
    closed!.snippet,
    "Nature Biotechnology · 2020 · 2387 citations · closed · Andrew V. Anzalone et al.",
  );
  assert.equal(oa!.snippet, "Nature Methods · 2023 · 312 citations · green · S. Qin");
});

// ── Enrichment (PIWEB-20): retracted / topic / type — present and absent ─────

const ENRICHED_WORK: OpenAlexWork = {
  ...NATURE_WORK,
  is_retracted: true,
  type: "article",
  primary_topic: { display_name: "Biotechnology" },
};

test("papers normalizer maps retracted, topic, and type onto the flat keys when the API provides them", () => {
  const [r] = normalizePaperResults([ENRICHED_WORK]);
  assert.equal(r!.retracted, true);
  assert.equal(r!.topic, "Biotechnology");
  assert.equal(r!.type, "article");
  // The retracted badge precedes the OA badge in the rendered snippet.
  assert.match(r!.snippet, /2387 citations · retracted · closed ·/);
  assert.match(r!.snippet, /closed · Biotechnology ·/);
});

test("papers normalizer omits the enrichment keys when the API lacks them — never invented", () => {
  const [r] = normalizePaperResults([NATURE_WORK]);
  assert.equal("retracted" in r!, false);
  assert.equal("topic" in r!, false);
  assert.equal("type" in r!, false);
  // Explicit null retraction (index doesn't know) is absent, not false.
  const [unknown] = normalizePaperResults([{ ...NATURE_WORK, is_retracted: null, type: null, primary_topic: null }]);
  assert.equal("retracted" in unknown!, false);
  assert.equal("topic" in unknown!, false);
  assert.equal("type" in unknown!, false);
});

// ── Authority (PIWEB-27): affiliations, venue type, reference count ─────────

// A company-lab paper: a dual-affiliated first author, a second author
// sharing one institution and adding an industry lab, an author with none,
// a repository venue, and a 133-entry bibliography.
const AUTHORITY_WORK: OpenAlexWork = {
  ...NATURE_WORK,
  primary_location: {
    landing_page_url: "https://doi.org/10.1038/s41587-020-0561-9",
    source: { display_name: "bioRxiv", type: "repository" },
  },
  authorships: [
    {
      author: { display_name: "Andrew V. Anzalone" },
      institutions: [
        { id: "https://openalex.org/I107606265", display_name: "Broad Institute", ror: "https://ror.org/05a0ya142", country_code: "US", type: "nonprofit" },
        { id: "https://openalex.org/I136199984", display_name: "Harvard University", ror: "https://ror.org/03vek6s52", country_code: "US", type: "education" },
      ],
    },
    {
      author: { display_name: "Luke W. Koblan" },
      // Harvard repeats — the list is deduped; Microsoft is the industry lab.
      institutions: [
        { id: "https://openalex.org/I136199984", display_name: "Harvard University", ror: "https://ror.org/03vek6s52", country_code: "US", type: "education" },
        { id: "https://openalex.org/I4210090666", display_name: "Microsoft (United States)", ror: "https://ror.org/00d0nc645", country_code: "US", type: "company" },
      ],
    },
    { author: { display_name: "Unaffiliated Author" }, institutions: [] },
  ],
  referenced_works: Array.from({ length: 133 }, (_, i) => `https://openalex.org/W${1000000000 + i}`),
};

test("papers normalizer surfaces every institution once with its type, country and stable id — a dual-affiliated author shows both", () => {
  const [r] = normalizePaperResults([AUTHORITY_WORK]);
  assert.deepEqual(r!.institutions, [
    { name: "Broad Institute", type: "nonprofit", country: "US", ror: "05a0ya142" },
    { name: "Harvard University", type: "education", country: "US", ror: "03vek6s52" },
    { name: "Microsoft (United States)", type: "company", country: "US", ror: "00d0nc645" },
  ]);
});

test("papers normalizer omits authority keys the API did not supply — never invented", () => {
  const [r] = normalizePaperResults([NATURE_WORK]);
  assert.equal("institutions" in r!, false);
  assert.equal("venueType" in r!, false);
  assert.equal("refCount" in r!, false);
});

test("an institution the API left bare keeps only its name — no type, country or ROR invented", () => {
  const [r] = normalizePaperResults([
    { ...BARE_WORK, authorships: [{ author: { display_name: "A" }, institutions: [{ display_name: "Somewhere" }] }] },
  ]);
  assert.deepEqual(r!.institutions, [{ name: "Somewhere" }]);
});

test("a work whose author list is institution-free leaves the key absent, not empty", () => {
  const [r] = normalizePaperResults([
    { ...BARE_WORK, authorships: [{ author: { display_name: "A" }, institutions: [] }] },
  ]);
  assert.equal("institutions" in r!, false);
});

test("an empty bibliography reports zero references rather than dropping the count", () => {
  const [r] = normalizePaperResults([{ ...BARE_WORK, referenced_works: [] }]);
  assert.equal(r!.refCount, 0);
});

test("isPaperRecord recognises a row carrying only an authority key", () => {
  assert.equal(isPaperRecord({ title: "t", url: "u", snippet: "", venueType: "repository" }), true);
  assert.equal(isPaperRecord({ title: "t", url: "u", snippet: "", refCount: 2 }), true);
});

// The shared page assembly both backends return through — one shape, one
// place that decides what a handle at the edge looks like.
test("paperPage slices to the page size and rides the handle only when it is a non-empty string", () => {
  const rows = [
    { title: "a", url: "u", snippet: "" },
    { title: "b", url: "u", snippet: "" },
    { title: "c", url: "u", snippet: "" },
  ];
  assert.deepEqual(paperPage(rows, 2).results.map((r) => r.title), ["a", "b"]);
  assert.equal("nextCursor" in paperPage(rows, 2), false);
  assert.equal(paperPage(rows, 2, { nextCursor: "CURSOR-2" }).nextCursor, "CURSOR-2");
  // An exhausted or absent handle never becomes an empty-string cursor the
  // agent would pass back.
  assert.equal("nextCursor" in paperPage(rows, 2, { nextCursor: null }), false);
  assert.equal("nextCursor" in paperPage(rows, 2, { nextCursor: "" }), false);
});

// The index's own match count — the number the envelope compares the rows
// against, and which the entry prints so the agent can see the shortfall.
test("paperPage carries the index's match count when the adapter reported one, and never invents it", () => {
  const rows = [{ title: "a", url: "u", snippet: "" }];
  assert.equal(paperPage(rows, 10, { total: 2148 }).total, 2148);
  assert.equal("total" in paperPage(rows, 10, {}), false);
  assert.equal("total" in paperPage(rows, 10), false);
  // A count is a number the wire sent or it is absent — a non-number is not
  // a count, and rendering it would print "NaN of undefined".
  assert.equal("total" in paperPage(rows, 10, { total: Number.NaN }), false);
});

// The shared builder directly (same module Europe PMC renders through):
test("buildPaperSnippet joins tokens and tolerates absent fields — the shared shape", () => {
  assert.equal(buildPaperSnippet({ venue: "V", year: 2020 }), "V · 2020");
  assert.equal(buildPaperSnippet({}), "");
  assert.equal(buildPaperSnippet({ authors: ["Solo Author"] }), "Solo Author");
  assert.equal(buildPaperSnippet({ authors: ["A", "B"] }), "A et al.");
});

test("buildPaperSnippet places the retracted badge before the OA badge — reading order weights it first", () => {
  assert.equal(
    buildPaperSnippet({ venue: "Nature Biotechnology", year: 2020, citedBy: 2387, retracted: true, oaToken: "closed", authors: ["Anzalone"] }),
    "Nature Biotechnology · 2020 · 2387 citations · retracted · closed · Anzalone",
  );
  // retracted: false renders nothing — only the flag, never a "clean" token.
  assert.equal(buildPaperSnippet({ oaToken: "closed", retracted: false }), "closed");
});

test("buildPaperSnippet carries the topic token and drops it when absent", () => {
  assert.equal(buildPaperSnippet({ venue: "V", topic: "Biotechnology" }), "V · Biotechnology");
  assert.equal(buildPaperSnippet({ venue: "V" }), "V");
  assert.equal(buildPaperSnippet({ venue: "V", retracted: true, oaToken: "green", topic: "Genetics" }), "V · retracted · green · Genetics");
});

// The shared URL policy directly (same module both backends rank through):
test("chooseFetchableUrl ranks PMC full text above doi.org, and doi.org above bare record pages", () => {
  assert.equal(
    chooseFetchableUrl([
      "https://doi.org/10.1/x",
      "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/",
      "https://doaj.org/article/x",
    ]),
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/",
  );
  assert.equal(
    chooseFetchableUrl(["https://doi.org/10.1/x", "https://openalex.org/W1"]),
    "https://doi.org/10.1/x",
  );
  // Metadata record views never outrank a doi.org resolution.
  assert.equal(
    chooseFetchableUrl(["https://doi.org/10.1/x", "https://europepmc.org/article/MED/1"]),
    "https://doi.org/10.1/x",
  );
  // Ties break by candidate order — the backend's preference wins.
  assert.equal(
    chooseFetchableUrl(["https://a.org/x", "https://b.org/y"]),
    "https://a.org/x",
  );
  assert.equal(chooseFetchableUrl([]), null);
  assert.equal(chooseFetchableUrl(["not-a-url", null, undefined]), null);
});

test("papers normalizer tolerates missing fields — no invented tokens or keys", () => {
  const [r] = normalizePaperResults([BARE_WORK]);
  assert.equal(r!.snippet, "");
  assert.equal("year" in r!, false);
  assert.equal("authors" in r!, false);
  assert.equal("venue" in r!, false);
  assert.equal("citedBy" in r!, false);
  assert.equal("doi" in r!, false);
  assert.equal(r!.url, "https://openalex.org/W9999999999");
});

test("papers normalizer keeps a work whose doi is an explicit null — record stays, doi key absent", () => {
  // The wire quirk that crashed the normalizer: OpenAlex sends "doi": null,
  // not a missing key. The record must survive normalization with no doi.
  const [r] = normalizePaperResults([
    { id: "https://openalex.org/W1234567890", title: "An older record without a DOI", doi: null },
  ]);
  assert.equal(r!.title, "An older record without a DOI");
  assert.equal(r!.url, "https://openalex.org/W1234567890");
  assert.equal("doi" in r!, false);
});

test("papers normalizer drops works with no record URL — no url, no action", () => {
  const results = normalizePaperResults([{ title: "no url anywhere" }, BARE_WORK]);
  assert.deepEqual(results.map((r) => r.title), ["A preprint with almost no metadata"]);
});

test("papers normalizer returns an empty array for empty input", () => {
  assert.deepEqual(normalizePaperResults([]), []);
});

// ── Deep-research keys: fwci, refs/related, citation trend, abstract ─────

// The RICH_WORK fixture: every deep-research key the API can carry, trimmed
// from the live capture (W2101234009, scikit-learn) plus capped graphs.
const RICH_WORK: OpenAlexWork = {
  id: "https://openalex.org/W2101234009",
  doi: "https://doi.org/10.48550/arxiv.1201.0490",
  title: "Scikit-learn: Machine Learning in Python",
  publication_year: 2012,
  cited_by_count: 63917,
  fwci: 54.51,
  referenced_works: [
    "https://openalex.org/W1496508106", "https://openalex.org/W1571024744",
    "https://openalex.org/W2024933578", null as unknown as string,
  ],
  related_works: ["https://openalex.org/W2036021480", "https://openalex.org/W2207495067"],
  counts_by_year: [
    { year: 2026, cited_by_count: 644 }, { year: 2025, cited_by_count: 3185 },
    { year: 2024, cited_by_count: 7789 }, { year: 2023, cited_by_count: 8513 },
  ],
  topics: [{
    display_name: "Computational Physics and Python Applications",
    score: 0.78, field: { display_name: "Computer Science" },
  }],
  keywords: [
    { display_name: "Python (programming language)" },
    { display_name: "Documentation" },
    { display_name: "Computer science" },
    { display_name: "Fourth keyword dropped by the cap" },
  ],
  abstract_inverted_index: { "Scikit-learn": [0], is: [1, 5], a: [2], Python: [3], module: [4] },
};

test("capIds keeps the first N bare ids and tolerates null entries — never invents", () => {
  assert.deepEqual(
    capIds(["https://openalex.org/W1", null, "https://openalex.org/W2", "https://openalex.org/W3"], 2),
    ["W1", "W2"],
  );
  assert.equal(capIds(undefined, 40), undefined);
  assert.equal(capIds([], 40), undefined);
  assert.equal(capIds([null, ""], 40), undefined);
});

test("citationTrend labels the trajectory off the last three complete years — never the partial current year", () => {
  const now = 2026;
  assert.deepEqual(citationTrend([{ year: 2025, cited_by_count: 3185 }, { year: 2024, cited_by_count: 7789 }, { year: 2023, cited_by_count: 8513 }, { year: 2026, cited_by_count: 644 }], now), { recent: 19487, trend: "fading" });
  // Rising: newest year outscores (synthetic counts within the window).
  assert.equal(
    citationTrend([{ year: 2024, cited_by_count: 900 }, { year: 2025, cited_by_count: 1000 }, { year: 2026, cited_by_count: 5000 }], now)?.trend,
    "rising",
  );
  // Steady: newest underscores by less than half (1000 vs 1100).
  assert.equal(
    citationTrend([{ year: 2024, cited_by_count: 1100 }, { year: 2025, cited_by_count: 1000 }], now)?.trend,
    "steady",
  );
  // Fewer than two complete known years → absent, never invented.
  assert.deepEqual(citationTrend([{ year: 2025, cited_by_count: 100 }], now), { recent: undefined, trend: undefined });
  assert.deepEqual(citationTrend([], now), { recent: undefined, trend: undefined });
});

test("abstractFromInvertedIndex rebuilds plaintext by position and truncates at 300; absent stays absent", () => {
  assert.equal(
    abstractFromInvertedIndex({ "Scikit-learn": [0], is: [1, 4], a: [2], Python: [3] }),
    "Scikit-learn is a Python is",
  );
  assert.equal(abstractFromInvertedIndex(null), undefined);
  assert.equal(abstractFromInvertedIndex({}), undefined);
  const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
  const built = abstractFromInvertedIndex(Object.fromEntries(long.split(" ").map((w, i) => [w, [i]])))!;
  assert.equal(built.length, 300); // 299 chars + ellipsis — the bound is exact
  assert.equal(built.endsWith("…"), true);
});

test("papers normalizer maps the deep-research keys: fwci, refs, related, trend, field, keywords, abstract, openalexId", () => {
  const [r] = normalizePaperResults([RICH_WORK]);
  assert.equal(r!.fwci, 54.51);
  assert.deepEqual(r!.refs, ["W1496508106", "W1571024744", "W2024933578"]);
  assert.deepEqual(r!.related, ["W2036021480", "W2207495067"]);
  assert.equal(r!.recentCitations, 19487);
  assert.equal(r!.citationTrend, "fading");
  assert.equal(r!.field, "Computer Science");
  // First 3 keyword names, in API order — the 4th is dropped by the cap.
  assert.deepEqual(r!.keywords, ["Python (programming language)", "Documentation", "Computer science"]);
  assert.equal(r!.openalexId, "W2101234009");
  assert.equal(r!.content, "Scikit-learn is a Python module is");
});

test("papers normalizer omits the deep-research keys when the API lacks them — never invented", () => {
  const [r] = normalizePaperResults([NATURE_WORK]);
  for (const key of ["fwci", "refs", "related", "recentCitations", "citationTrend", "field", "keywords", "content"] as const) {
    assert.equal(key in r!, false, `${key} should be absent`);
  }
  const [urlOnly] = normalizePaperResults([{ title: "t", primary_location: { landing_page_url: "https://example.org/paper" } }]);
  assert.equal("openalexId" in urlOnly!, false);
});

test("isPaperRecord detects the flat paper keys on generic result rows", () => {
  const [r] = normalizePaperResults([NATURE_WORK]);
  assert.equal(isPaperRecord(r as SearchResult), true);
  assert.equal(isPaperRecord({ title: "t", url: "https://e.com", snippet: "s" }), false);
  // An OA-only record — oaUrl alone is enough to read as a paper record.
  assert.equal(isPaperRecord(normalizePaperResults([OA_WORK])[0] as unknown as SearchResult), true);
});

// ── buildPaperParams — search, per-page, api_key only when a key resolves ────

test("paper params carry the search query, per-page, the shared select= projection, and omit api_key when keyless", () => {
  const p = buildPaperParams("CRISPR base editing", 10, null);
  assert.equal(p.get("search"), "CRISPR base editing");
  assert.equal(p.get("per-page"), "10");
  assert.equal(p.get("api_key"), null);
  // Lean payloads: every works-list call projects the same field list.
  assert.equal(p.get("select"), OPENALEX_SELECT);
  assert.match(OPENALEX_SELECT, /^id,doi,title,publication_year,cited_by_count,is_retracted,type,/);
  // The deep-research tail: fwci, reference/related graphs, the citation
  // trend source, topics/keywords namespaces, and the abstract source.
  assert.match(OPENALEX_SELECT, /open_access,best_oa_location,primary_location,authorships,locations,primary_topic,ids,fwci,referenced_works,related_works,counts_by_year,topics,keywords,abstract_inverted_index$/);
});

test("paper params carry api_key when a key resolves; mailto never appears", () => {
  const p = buildPaperParams("q", 15, "oa-key-123");
  assert.equal(p.get("api_key"), "oa-key-123");
  assert.equal(p.get("per-page"), "15");
  // The retired politeness param is dead on every built shape.
  assert.equal(p.get("mailto"), null);
});

test("paper params carry the citedBy sort server-side; relevance when sort is absent", () => {
  const sorted = buildPaperParams("lichen", 10, null, "", "citedBy");
  assert.equal(sorted.get("sort"), "cited_by_count:desc");
  const unsorted = buildPaperParams("lichen", 10, null);
  assert.equal(unsorted.get("sort"), null);
});

test("paper params carry the date sort server-side — newest first, across the whole index", () => {
  assert.equal(buildPaperParams("lichen", 10, null, "", "date").get("sort"), "publication_date:desc");
});

test("paper params carry the cursor verbatim; an absent cursor stays off the wire", () => {
  const p = buildPaperParams("q", 10, null, "", undefined, "IlsxNzQ4");
  assert.equal(p.get("cursor"), "IlsxNzQ4");
  // Today's behaviour: no cursor, no param — the first page is unfiltered.
  assert.equal(buildPaperParams("q", 10, null).get("cursor"), null);
});

// ── resolveOpenAlexKey — config wins, env fallback, keyless tolerated ─────────

test("openalex key resolution: config wins over env; env alone works; neither → keyless", () => {
  assert.equal(resolveOpenAlexKey("cfg-key", "env-key"), "cfg-key");
  assert.equal(resolveOpenAlexKey(undefined, "env-key"), "env-key");
  assert.equal(resolveOpenAlexKey("cfg-key", undefined), "cfg-key");
  assert.equal(resolveOpenAlexKey(undefined, undefined), null);
  // Blank config falls through to env; both blank → keyless, not an empty param.
  assert.equal(resolveOpenAlexKey("  ", "env-key"), "env-key");
  assert.equal(resolveOpenAlexKey("", "  "), null);
  assert.equal(resolveOpenAlexKey("  padded  ", undefined), "padded");
});

// ── openAlexErrorDetail — the metering slice of the backend-down contract ───

test("openalex error detail: 429 with zero remaining reports credits exhausted — keyless names the key fix", () => {
  const d = openAlexErrorDetail(429, 0, null, 300, false);
  assert.match(d!, /daily credits exhausted/);
  assert.match(d!, /openalex\.org\/settings\/api/);
  assert.match(d!, /\/openalex-setup/);
});

test("openalex error detail: keyed exhaustion names the reset from X-RateLimit-Reset", () => {
  const d = openAlexErrorDetail(429, 0, null, 120, true);
  assert.match(d!, /daily credits exhausted/);
  assert.match(d!, /120 seconds/);
  assert.match(d!, /midnight UTC/);
  assert.doesNotMatch(d!, /settings\/api/);
  // Header absent — still keyed-exhaustion, just no countdown.
  assert.match(openAlexErrorDetail(429, 0, null, null, true)!, /resets at midnight UTC/);
});

test("openalex error detail: 429 with remaining budget reports throttling, retry shortly", () => {
  assert.match(openAlexErrorDetail(429, 7, null, 60, false)!, /temporary throttling/);
  assert.match(openAlexErrorDetail(429, null, 0.05, 60, true)!, /temporary throttling/);
  assert.match(openAlexErrorDetail(429, 7, null, 60, false)!, /retry shortly/);
});

test("openalex error detail: 401/403 report key rejected without ever echoing the key", () => {
  for (const status of [401, 403]) {
    const d = openAlexErrorDetail(status, null, null, null, true)!;
    assert.match(d, /key rejected/);
    assert.match(d, /OPENALEX_API_KEY/);
    assert.doesNotMatch(d, /secret-oa-key/);
  }
});

test("openalex error detail: non-metering statuses fall through to null", () => {
  assert.equal(openAlexErrorDetail(500, null, null, null, false), null);
  assert.equal(openAlexErrorDetail(503, null, null, null, true), null);
});

// ── buildOpenAlexFilter — the exact filter= grammar (PIWEB-16) ────────────────

test("openalex filter string: exact year, OA flag, and passthrough when empty", () => {
  // Retracted works are excluded by default (the reading-candidate default),
  // so every non-walk filter list carries is_retracted:false first.
  assert.equal(buildOpenAlexFilter({ year: 2023 }), "is_retracted:false,publication_year:2023");
  assert.equal(buildOpenAlexFilter({ openAccess: true }), "is_retracted:false,is_oa:true");
  assert.equal(buildOpenAlexFilter(undefined), "is_retracted:false");
  assert.equal(buildOpenAlexFilter({}), "is_retracted:false");
  // includeRetracted drops the clause rather than badging.
  assert.equal(buildOpenAlexFilter({ includeRetracted: true }), "");
  assert.equal(buildOpenAlexFilter({ includeRetracted: true, year: 2023 }), "publication_year:2023");
});

test("openalex filter string: year range splits into from/to dates, combos comma-join", () => {
  assert.equal(
    buildOpenAlexFilter({ yearRange: [2019, 2021] }),
    "is_retracted:false,from_publication_date:2019-01-01,to_publication_date:2021-12-31",
  );
  assert.equal(
    buildOpenAlexFilter({ year: 2023, openAccess: true }),
    "is_retracted:false,publication_year:2023,is_oa:true",
  );
});

test("openalex filter string carries the walk legs in the same list — cites:W forward, cited_by:W backward", () => {
  assert.equal(
    buildOpenAlexFilter({ openAccess: true }, "W3161425918"),
    "is_retracted:false,is_oa:true,cites:W3161425918",
  );
  // Backward: the seed's own references, resolved server-side in one call.
  assert.equal(
    buildOpenAlexFilter({ openAccess: true }, "W3161425918", "citedBy"),
    "is_retracted:false,is_oa:true,cited_by:W3161425918",
  );
  assert.equal(buildOpenAlexFilter(undefined, "W1", "citedBy"), "is_retracted:false,cited_by:W1");
});

test("paper params carry the filter and omit search when the walk leaves it empty", () => {
  const p = buildPaperParams("", 10, null, "cites:W3161425918");
  assert.equal(p.get("search"), null);
  assert.equal(p.get("filter"), "cites:W3161425918");
  assert.equal(p.get("per-page"), "10");
});

// ── Expression door (PIWEB-26): the retraction merge rule, pure ─────────────
// The agent's own filter list is foreign text. The merge appends the plugin's
// clause only when absent, never rewrites a clause, and declines text the
// filter grammar cannot read rather than corrupting it.

test("the retraction clause is appended to the agent's expression, whose own clauses are untouched", () => {
  assert.equal(mergeRetractionClause("publication_year:2020"), "publication_year:2020,is_retracted:false");
  assert.equal(
    mergeRetractionClause("type:article,is_oa:true"),
    "type:article,is_oa:true,is_retracted:false",
  );
});

test("an expression that already carries an is_retracted clause is not given a second copy — either polarity", () => {
  assert.equal(mergeRetractionClause("is_retracted:false"), "is_retracted:false");
  assert.equal(mergeRetractionClause("is_retracted:true"), "is_retracted:true");
  assert.equal(mergeRetractionClause("type:article,is_retracted:true"), "type:article,is_retracted:true");
});

test("includeRetracted leaves the agent's expression alone", () => {
  assert.equal(mergeRetractionClause("type:article", true), "type:article");
});

test("text that is not a filter expression is declined rather than corrupted", () => {
  for (const notAnExpression of [
    "works where year is (2020)",   // OQL — a different syntax, and a different endpoint
    "",
    "   ",
    "publication_year",             // no clause operator
    "publication_year:",            // empty value
    "just some words",
  ]) {
    assert.equal(mergeRetractionClause(notAnExpression), null, `"${notAnExpression}" should decline`);
  }
});

test("a quoted value may carry the clause separator without splitting the clause", () => {
  assert.equal(
    mergeRetractionClause('title.search:"cancer, and its causes"'),
    'title.search:"cancer, and its causes",is_retracted:false',
  );
});

// ── The named set and the accepted set (PIWEB-31) ────────────────────────────
// The grammar lists are what the description is built from, and the probe
// exercises every operator in them. These tests pin that the adapter forwards
// that whole vocabulary unchanged; papers-live-smoke pins that the API accepts
// it. The field catalogue is deliberately absent from the description — the
// API's own catalogue is the source of truth there.

test("the operator probe exercises every operator the grammar declares, and the adapter forwards it", () => {
  for (const { token } of OPENALEX_FILTER_GRAMMAR) {
    assert.ok(
      OPENALEX_FILTER_PROBE.includes(token),
      `the probe does not exercise ${token} — a new operator could ride in unnamed`,
    );
  }
  assert.equal(
    buildOpenAlexExpressionFilter({ expression: OPENALEX_FILTER_PROBE }),
    `${OPENALEX_FILTER_PROBE},is_retracted:false`,
  );
});

test("every family field the description names is forwarded, not rewritten or rejected", () => {
  for (const { family, field } of OPENALEX_FILTER_FAMILIES) {
    assert.equal(
      buildOpenAlexExpressionFilter({ expression: `${field}:x` }),
      `${field}:x,is_retracted:false`,
      `${family} (${field}) was rewritten or rejected`,
    );
  }
});

// ── searchPapers — deps flow, slicing, error shaping ──────────────────────────
// The dispatch's third arg now carries per-backend deps; Europe PMC gets a
// tripwire here — these tests pin the OpenAlex path, so any silent misroute
// fails loudly.

function depsWith(overrides: Partial<OpenAlexDeps>): Parameters<typeof searchPapers>[2] {
  // The adapter now returns a page ({works, nextCursor}); stubs below still
  // speak in record arrays, so the harness lifts an array into a cursor-less
  // page and passes a real page through untouched.
  const fetchWorks = overrides.fetchWorks ?? (async () => [NATURE_WORK, OA_WORK]);
  return {
    openalex: {
      fetchRecord: async () => { throw new Error("OpenAlex record fetch must not run outside walk tests"); },
      ...overrides,
      fetchWorks: async (params, signal) => {
        const out = await fetchWorks(params, signal);
        return Array.isArray(out) ? { works: out } : out;
      },
    },
    europepmc: {
      fetchResults: async () => { throw new Error("Europe PMC must not be called for index: 'openalex' tests"); },
      fetchRoute: async () => { throw new Error("Europe PMC walk must not be called for index: 'openalex' tests"); },
    },
  };
}

test("searchPapers returns normalized paper records on the happy path", async () => {
  const { results } = await searchPapers("CRISPR base editing", {}, depsWith({}));
  assert.equal(results.length, 2);
  assert.equal(results[0]!.doi, "10.1038/s41587-020-0561-9");
});

test("searchPapers carries the deep-research keys through the dispatch — the agent reads them off a plain search", async () => {
  const { results } = await searchPapers("CRISPR base editing", {}, depsWith({
    fetchWorks: async () => [RICH_WORK],
  }));
  const [r] = results;
  // Every deep-research key survives the dispatch — nothing is lost between
  // the normalizer and the caller's hands.
  for (const key of ["fwci", "refs", "related", "recentCitations", "citationTrend", "field", "keywords", "openalexId"] as const) {
    assert.notEqual(key in (r ?? {}), false, `${key} should ride through`);
  }
  assert.equal(r!.content, "Scikit-learn is a Python module is");
});

test("searchPapers carries institutions, venue type and reference count through the dispatch", async () => {
  const { results } = await searchPapers("q", {}, depsWith({ fetchWorks: async () => [AUTHORITY_WORK] }));
  const [r] = results;
  assert.equal(r!.venueType, "repository");
  assert.equal(r!.refCount, 133);
  assert.deepEqual(
    r!.institutions?.map((i) => i.name),
    ["Broad Institute", "Harvard University", "Microsoft (United States)"],
  );
});

test("searchPapers passes the query, numResults, and signal through to the fetch", async () => {
  const seen: Array<{ params: URLSearchParams; signal?: AbortSignal }> = [];
  const signal = new AbortController().signal;
  const options: SearchOptions = { numResults: 7, signal };
  await searchPapers("prime editing", options, depsWith({
    fetchWorks: async (params, sig) => {
      seen.push({ params, signal: sig });
      return [NATURE_WORK];
    },
  }));
  assert.equal(seen[0]!.params.get("search"), "prime editing");
  assert.equal(seen[0]!.params.get("per-page"), "7");
  assert.equal(seen[0]!.signal, signal);
});

test("searchPapers slices results to numResults", async () => {
  const { results } = await searchPapers("q", { numResults: 1 }, depsWith({}));
  assert.equal(results.length, 1);
});

test("searchPapers passes filters.cursor to the API and returns the response's next cursor unmodified", async () => {
  const seen: URLSearchParams[] = [];
  const page = await searchPapers("q", { filters: { cursor: "CURSOR-1" } }, depsWith({
    fetchWorks: async (params) => {
      seen.push(params);
      return { works: [NATURE_WORK], nextCursor: "CURSOR-2" };
    },
  }));
  assert.equal(seen[0]!.get("cursor"), "CURSOR-1");
  // The cursor comes back byte-for-byte — the agent passes it on untouched.
  assert.equal(page.nextCursor, "CURSOR-2");
  assert.equal(page.results.length, 1);
});

test("searchPapers omits nextCursor when the result set is exhausted", async () => {
  const page = await searchPapers("q", {}, depsWith({}));
  assert.equal("nextCursor" in page, false);
});

test("searchPapers sends filters.expression as written and merges only the retraction clause", async () => {
  const seen: URLSearchParams[] = [];
  const { results } = await searchPapers("", {
    filters: { expression: "cites:W1|W2|W3,type:article" },
  }, depsWith({
    fetchWorks: async (params) => { seen.push(params); return [NATURE_WORK]; },
  }));
  assert.equal(seen.length, 1, "one call is one request — no fan-out behind the door");
  // The multi-seed or-list rides one request, untouched, with the plugin's
  // clause appended — never rewritten, reordered or dropped.
  assert.equal(seen[0]!.get("filter"), "cites:W1|W2|W3,type:article,is_retracted:false");
  assert.equal(seen[0]!.get("search"), null);
  assert.equal(results.length, 1);
});

test("the expression composes with cursor and sort — the plugin merges no other clause into it", async () => {
  const seen: URLSearchParams[] = [];
  await searchPapers("q", {
    filters: { expression: "type:article", cursor: "C1", sort: "citedBy" },
  }, depsWith({
    fetchWorks: async (params) => { seen.push(params); return { works: [NATURE_WORK], nextCursor: "C2" }; },
  }));
  assert.equal(seen[0]!.get("filter"), "type:article,is_retracted:false");
  assert.equal(seen[0]!.get("cursor"), "C1");
  assert.equal(seen[0]!.get("sort"), "cited_by_count:desc");
});

test("an OQL query is declined as OQL, with the filter form it maps to — not as anonymous junk", async () => {
  await assert.rejects(
    searchPapers("q", { filters: { expression: "works where year is (2020)" } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /is OQL, the API root's query language/);
      // A worked translation beats a rule: the agent gets the classic form
      // for the query it actually wrote.
      assert.match(m, /e\.g\. "works where year is \(2020\)" becomes publication_year:2020/);
      // The one place the retraction rule's limit is stated.
      assert.match(m, /Only the filter form excludes retracted works by default/);
      // Rerouting an OpenAlex-only syntax to the other adapter would send the
      // agent in a circle — the decline names no index.
      assert.doesNotMatch(m, /index: "europepmc"/);
      return true;
    },
  );
});

test("an OQL query that groups is told the shape is out of scope, not only the syntax", async () => {
  await assert.rejects(
    searchPapers("q", { filters: { expression: "works where year is (2020) group by type" } }, depsWith({})),
    (err: unknown) => /returns works, not counts by group/.test((err as Error).message),
  );
});

test("text that is neither OQL nor a filter expression is declined generically", async () => {
  await assert.rejects(
    searchPapers("q", { filters: { expression: "some words" } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /is not a filter expression/);
      assert.match(m, /publication_year:2020,is_oa:true,type:article/);
      assert.doesNotMatch(m, /is OQL/);
      return true;
    },
  );
});

test("a constraint the plugin composes cannot ride with the expression — declined, not silently dropped", async () => {
  await assert.rejects(
    searchPapers("q", { filters: { expression: "type:article", year: 2020 } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /year into it/);
      assert.match(m, /publication_year:2020/);
      return true;
    },
  );
});

test("an expression riding with a citation walk is refused rather than half-applied", async () => {
  await assert.rejects(
    searchPapers("", { filters: { expression: "cites:W1", citationGraph: { seed: "W1" } } }, depsWith({})),
    (err: unknown) => /citationGraph into it/.test((err as Error).message),
  );
});

test("selecting Europe PMC with an expression declines in band, naming the adapter that serves it", async () => {
  await assert.rejects(
    searchPapers("malaria", { index: "europepmc", filters: { expression: "type:article" } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /Europe PMC rejected the query as malformed/);
      assert.match(m, /write the constraint into the query/);
      // The retired lookup's destination on this adapter is named too.
      assert.match(m, /DOI:"10\.…"/);
      assert.match(m, /EXT_ID:22955618/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("the works adapter declines filters.synonym in band — the biomedical index owns that lever", async () => {
  await assert.rejects(
    searchPapers("malaria", { filters: { synonym: true } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /filters\.synonym is Europe PMC's recall lever/);
      assert.match(m, /index: "europepmc"/);
      return true;
    },
  );
});

test("the expression rides the search-cache key — two expressions are two keys", () => {
  assert.notEqual(
    filtersCacheKey({ expression: "type:article" }),
    filtersCacheKey({ expression: "type:preprint" }),
  );
  assert.notEqual(filtersCacheKey({ expression: "type:article" }), filtersCacheKey({}));
});

test("searchPapers surfaces a rejected cursor as malformed with the API's own complaint", async () => {
  await assert.rejects(
    searchPapers("q", { filters: { cursor: "stale" } }, depsWith({
      fetchWorks: async () => { throw new OpenAlexHttpError(400, null, null, null, "Invalid cursor value"); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed \(Invalid cursor value\)/);
      assert.doesNotMatch(m, /unreachable/);
      return true;
    },
  );
});

test("a rejected filter expression reaches the agent as the backend's own complaint, quoted and bounded", async () => {
  // The real 400 body for an unknown field is a catalogue of every valid field
  // — the failure mode that would otherwise carry thousands of characters into
  // the agent's context on a routine typo. The opening sentence is actionable;
  // the catalogue is not.
  const catalogue = "publication_yearx is not a valid field. Valid fields are underscore or hyphenated versions of: "
    + "abstract.search, ".repeat(300);
  await assert.rejects(
    searchPapers("q", { filters: { expression: "publication_yearx:2020" } }, depsWith({
      fetchWorks: async () => { throw new OpenAlexHttpError(400, null, null, null, catalogue); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      // Quoted, not paraphrased — and the quote is visibly elided.
      assert.match(m, /rejected the query as malformed \(publication_yearx is not a valid field\./);
      assert.match(m, /…/, "the elision must be visible, not silent");
      assert.ok(m.length < 600, `the complaint should be bounded, got ${m.length} chars`);
      // An OpenAlex-only expression has no other index to try; the fix is local.
      assert.doesNotMatch(m, /index: "europepmc"/);
      return true;
    },
  );
});

test("searchPapers wraps fetch failures as the in-band contract — backend named, retry index offered", async () => {
  await assert.rejects(
    searchPapers("q", {}, depsWith({ fetchWorks: async () => { throw new Error("OpenAlex returned 429"); } })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /OpenAlex was unreachable \(OpenAlex returned 429\)/);
      assert.match(m, /index: "europepmc"/);
      return true;
    },
  );
});

test("searchPapers carries api_key on the built params when a key resolves; keyless omits it", async () => {
  const seen: URLSearchParams[] = [];
  await searchPapers("q", {}, depsWith({
    resolveKey: () => "secret-oa-key",
    fetchWorks: async (params) => { seen.push(params); return [NATURE_WORK]; },
  }));
  assert.equal(seen[0]!.get("api_key"), "secret-oa-key");
  assert.equal(seen[0]!.get("mailto"), null);
  seen.length = 0;
  await searchPapers("q", {}, depsWith({
    resolveKey: () => null,
    fetchWorks: async (params) => { seen.push(params); return [NATURE_WORK]; },
  }));
  assert.equal(seen[0]!.get("api_key"), null);
});

test("a metered 429 (zero remaining) surfaces the credits-exhausted text — keyed vs keyless", async () => {
  await assert.rejects(
    searchPapers("q", {}, depsWith({
      resolveKey: () => "secret-oa-key",
      fetchWorks: async () => { throw new OpenAlexHttpError(429, 0, null, 45); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /daily credits exhausted — budget resets in 45 seconds/);
      assert.doesNotMatch(m, /secret-oa-key/);
      return true;
    },
  );
  await assert.rejects(
    searchPapers("q", {}, depsWith({
      resolveKey: () => null,
      fetchWorks: async () => { throw new OpenAlexHttpError(429, 0, null, 45); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /daily credits exhausted/);
      assert.match(m, /\/openalex-setup/);
      return true;
    },
  );
});

test("a metered 429 with remaining budget surfaces the throttled/retry text", async () => {
  await assert.rejects(
    searchPapers("q", {}, depsWith({
      fetchWorks: async () => { throw new OpenAlexHttpError(429, 6, null, null); },
    })),
    (err: unknown) => {
      assert.match((err as Error).message, /temporary throttling .* retry shortly/);
      return true;
    },
  );
});

test("a 401 from OpenAlex surfaces the key-rejected text", async () => {
  await assert.rejects(
    searchPapers("q", {}, depsWith({
      fetchWorks: async () => { throw new OpenAlexHttpError(401, null, null, null); },
    })),
    (err: unknown) => {
      assert.match((err as Error).message, /key rejected \(HTTP 401\)/);
      return true;
    },
  );
});

test("searchPapers throws no-results on zero parseable records — no fake success", async () => {
  await assert.rejects(
    searchPapers("q", {}, depsWith({ fetchWorks: async () => [{ title: "no url anywhere" }] })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /returned no results/);
      assert.doesNotMatch(m, /unreachable/);
      return true;
    },
  );
});
