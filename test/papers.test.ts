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
  normalizePaperResults,
  buildPaperParams,
  buildOpenAlexFilter,
  buildOpenAlexBackwardFilter,
  searchPapers,
  type OpenAlexWork,
  type OpenAlexDeps,
} from "../search/papers.ts";
import { buildPaperSnippet, chooseFetchableUrl, type PaperRecord } from "../search/paper-backend.ts";
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

// The shared builder directly (same module Europe PMC renders through):
test("buildPaperSnippet joins tokens and tolerates absent fields — the shared shape", () => {
  assert.equal(buildPaperSnippet({ venue: "V", year: 2020 }), "V · 2020");
  assert.equal(buildPaperSnippet({}), "");
  assert.equal(buildPaperSnippet({ authors: ["Solo Author"] }), "Solo Author");
  assert.equal(buildPaperSnippet({ authors: ["A", "B"] }), "A et al.");
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

test("isPaperRecord detects the flat paper keys on generic result rows", () => {
  const [r] = normalizePaperResults([NATURE_WORK]);
  assert.equal(isPaperRecord(r as SearchResult), true);
  assert.equal(isPaperRecord({ title: "t", url: "https://e.com", snippet: "s" }), false);
  // An OA-only record — oaUrl alone is enough to read as a paper record.
  assert.equal(isPaperRecord(normalizePaperResults([OA_WORK])[0] as unknown as SearchResult), true);
});

// ── buildPaperParams — search, per-page, mailto only when present ─────────────

test("paper params carry the search query and per-page, and omit mailto when no contact is set", () => {
  const p = buildPaperParams("CRISPR base editing", 10, null);
  assert.equal(p.get("search"), "CRISPR base editing");
  assert.equal(p.get("per-page"), "10");
  assert.equal(p.get("mailto"), null);
});

test("paper params include the politeness mailto when one is configured", () => {
  const p = buildPaperParams("q", 15, "udit@example.com");
  assert.equal(p.get("mailto"), "udit@example.com");
  assert.equal(p.get("per-page"), "15");
});

// ── buildOpenAlexFilter — the exact filter= grammar (PIWEB-16) ────────────────

test("openalex filter string: exact year, OA flag, and passthrough when empty", () => {
  assert.equal(buildOpenAlexFilter({ year: 2023 }), "publication_year:2023");
  assert.equal(buildOpenAlexFilter({ openAccess: true }), "is_oa:true");
  assert.equal(buildOpenAlexFilter(undefined), "");
  assert.equal(buildOpenAlexFilter({}), "");
});

test("openalex filter string: year range splits into from/to dates, combos comma-join", () => {
  assert.equal(
    buildOpenAlexFilter({ yearRange: [2019, 2021] }),
    "from_publication_date:2019-01-01,to_publication_date:2021-12-31",
  );
  assert.equal(
    buildOpenAlexFilter({ year: 2023, openAccess: true }),
    "publication_year:2023,is_oa:true",
  );
});

test("openalex filter string carries the forward walk's cites:W leg in the same list", () => {
  assert.equal(
    buildOpenAlexFilter({ openAccess: true }, "W3161425918"),
    "is_oa:true,cites:W3161425918",
  );
});

test("openalex backward filter strips record URLs into one OR-list", () => {
  assert.equal(
    buildOpenAlexBackwardFilter([
      "https://openalex.org/W1504222414",
      "https://openalex.org/W1919257374",
    ]),
    "openalex_id:W1504222414|W1919257374",
  );
});

test("paper params carry the filter and omit search when the walk leaves it empty", () => {
  const p = buildPaperParams("", 10, null, "cites:W3161425918");
  assert.equal(p.get("search"), null);
  assert.equal(p.get("filter"), "cites:W3161425918");
  assert.equal(p.get("per-page"), "10");
});

// ── searchPapers — deps flow, slicing, error shaping ──────────────────────────
// The dispatch's third arg now carries per-backend deps; Europe PMC gets a
// tripwire here — these tests pin the OpenAlex path, so any silent misroute
// fails loudly.

function depsWith(overrides: Partial<OpenAlexDeps>): Parameters<typeof searchPapers>[2] {
  return {
    openalex: {
      fetchWorks: async () => [NATURE_WORK, OA_WORK],
      fetchRecord: async () => { throw new Error("OpenAlex record fetch must not run outside walk tests"); },
      ...overrides,
    },
    europepmc: {
      fetchResults: async () => { throw new Error("Europe PMC must not be called for index: 'openalex' tests"); },
      fetchRoute: async () => { throw new Error("Europe PMC walk must not be called for index: 'openalex' tests"); },
    },
  };
}

test("searchPapers returns normalized paper records on the happy path", async () => {
  const results = await searchPapers("CRISPR base editing", {}, depsWith({}));
  assert.equal(results.length, 2);
  assert.equal(results[0]!.doi, "10.1038/s41587-020-0561-9");
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
  const results = await searchPapers("q", { numResults: 1 }, depsWith({}));
  assert.equal(results.length, 1);
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
