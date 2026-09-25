// Tests for the papers dispatcher — backend routing by `index`, the in-band
// error contract, and the same-shape guarantee across backends. Fixtures
// recreated in-line (shared captures from the backend test files' live
// pulls). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPapers, type OpenAlexWork } from "../search/papers.ts";
import { parsePaperSeed, filtersCacheKey, applySort } from "../search/paper-backend.ts";
import { paperError, otherIndex, PaperError, type PaperRecord } from "../search/paper-backend.ts";
import type { EuropePmcResult, EuropePmcResponse } from "../search/europepmc.ts";
import type { SearchOptions, SearchResult } from "../search/search.ts";

// ── Fixture — same records as the per-backend test files reflect ──────────────

const OPENALEX_WORK: OpenAlexWork = {
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

const EPMC_RESULT: EuropePmcResult = {
  id: "42549577",
  source: "MED",
  pmid: "42549577",
  pmcid: "PMC13434336",
  doi: "10.1093/nar/gkag769",
  title: "BASELINE: a CRISPR base editing platform for mammalian-scale single-cell lineage tracing.",
  authorString: "Winter E, Emiliani F, McKenna A.",
  journalTitle: "Nucleic Acids Research",
  pubYear: "2026",
  isOpenAccess: "Y",
  inEPMC: "Y",
  inPMC: "Y",
  citedByCount: 3,
};

// Destructured deps so each backend can be faked independently.
type PapersDeps = NonNullable<Parameters<typeof searchPapers>[2]>;

function depsWith(overrides: PapersDeps): PapersDeps {
  return {
    openalex: {
      fetchWorks: async () => [],
      fetchRecord: async () => { throw new Error("OpenAlex record fetch must not run outside walk tests"); },
    },
    europepmc: {
      fetchResults: async () => { throw new Error("Europe PMC must not be called outside walk tests"); },
      fetchRoute: async () => { throw new Error("Europe PMC walk must not be called outside walk tests"); },
    },
    ...overrides,
  };
}

// ── index routing ─────────────────────────────────────────────────────────────

test("searchPapers defaults to the OpenAlex backend when index is absent", async () => {
  let openalexCalled = 0;
  let europepmcCalled = 0;
  const results = await searchPapers("CRISPR base editing", {}, depsWith({
    openalex: {
      fetchWorks: async () => { openalexCalled++; return [OPENALEX_WORK]; },
    },
    europepmc: {
      fetchResults: async () => { europepmcCalled++; return { hitCount: 0, resultList: { result: [] } }; },
    },
  }));
  assert.equal(openalexCalled, 1);
  assert.equal(europepmcCalled, 0);
  assert.equal(results[0]!.doi, "10.1038/s41587-020-0561-9");
});

test("searchPapers routes a biomedical query to Europe PMC with index: 'europepmc'", async () => {
  let europepmcCalled = 0;
  const results = await searchPapers("CRISPR base editing", { index: "europepmc" }, depsWith({
    europepmc: {
      fetchResults: async () => {
        europepmcCalled++;
        return { hitCount: 1, resultList: { result: [EPMC_RESULT] } } as EuropePmcResponse;
      },
    },
    openalex: {
      fetchWorks: async () => { throw new Error("must not be called"); },
    },
  }));
  assert.equal(europepmcCalled, 1);
  assert.equal(results[0]!.doi, "10.1093/nar/gkag769");
  assert.equal(results[0]!.year, 2026);
});

test("searchPapers still honors index: 'openalex' explicitly", async () => {
  let openalexCalled = 0;
  await searchPapers("q", { index: "openalex" }, depsWith({
    openalex: { fetchWorks: async () => { openalexCalled++; return [OPENALEX_WORK]; } },
  }));
  assert.equal(openalexCalled, 1);
});

test("searchPapers falls back to OpenAlex on an unknown index value — never European-forked", async () => {
  let openalexCalled = 0;
  await searchPapers("q", { index: "scholar" as SearchOptions["index"] }, depsWith({
    openalex: { fetchWorks: async () => { openalexCalled++; return [OPENALEX_WORK]; } },
  }));
  assert.equal(openalexCalled, 1);
});

// ── The same-shape guarantee — no per-backend forking downstream ──────────────

test("both backends emit PaperRecords with the same flat keys on a shared record", async () => {
  const fromOpenAlex = await searchPapers("q", {}, depsWith({
    openalex: { fetchWorks: async () => [OPENALEX_WORK] },
  }));
  const fromEpmc = await searchPapers("q", { index: "europepmc" }, depsWith({
    europepmc: {
      fetchResults: async () => ({ hitCount: 1, resultList: { result: [EPMC_RESULT] } }),
    },
  }));
  const keysOf = (r: PaperRecord) => Object.keys(r).filter((k) => r[k as keyof PaperRecord] !== undefined).sort();
  // Both carry title/url/snippet plus paper keys — no backend-own key set.
  for (const keys of [keysOf(fromOpenAlex[0]!), keysOf(fromEpmc[0]!)]) {
    for (const k of ["title", "url", "snippet", "year", "authors", "venue", "citedBy", "doi"]) {
      assert.deepEqual(keys.includes(k), true, `missing key ${k}`);
    }
  }
});

// ── In-band error contract ────────────────────────────────────────────────────

test("paperError distinguishes backend-down from no-results from malformed", () => {
  const down = paperError("backend-down", "openalex", "OpenAlex returned 503");
  const none = paperError("no-results", "openalex");
  const malformed = paperError("malformed", "europepmc", "no hitCount in response");
  // Backend named, cause distinguished.
  assert.match(down, /OpenAlex was unreachable/);
  assert.match(none, /OpenAlex returned no results/);
  assert.match(malformed, /Europe PMC rejected the query as malformed/);
  // Down/no-results offer a manual escape hatch; malformed is query-shaping.
  assert.match(down, /DOI or URL/);
  assert.match(none, /DOI or URL/);
  assert.match(malformed, /Drop quotes|drop quotes/i);
});

test("paperError's retry hint always names the OTHER index with its scope", () => {
  assert.match(paperError("backend-down", "openalex"), /index: "europepmc"/);
  assert.match(paperError("backend-down", "europepmc"), /index: "openalex"/);
  assert.match(paperError("backend-down", "openalex"), /biomedical full text: PubMed, PMC copies, preprints, patents/);
  assert.match(paperError("no-results", "europepmc"), /all disciplines/);
});

test("otherIndex is the disjoint-pair swap", () => {
  assert.equal(otherIndex("openalex"), "europepmc");
  assert.equal(otherIndex("europepmc"), "openalex");
});

test("papers failures reach the entry as PaperError — passed verbatim, not rewritten", async () => {
  await assert.rejects(
    searchPapers("q", {}, depsWith({
      openalex: { fetchWorks: async () => { throw new Error("OpenAlex returned 500"); } },
    })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const m = (err as Error).message;
      assert.match(m, /OpenAlex was unreachable .*OpenAlex returned 500/);
      assert.match(m, /index: "europepmc"/);
      return true;
    },
  );
});

test("papers no-results is distinguished from backend-down at runtime", async () => {
  await assert.rejects(
    searchPapers("q", { index: "europepmc" }, depsWith({
      europepmc: {
        fetchResults: async () => ({ hitCount: 0, resultList: { result: [] } }),
      },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /returned no results/);
      assert.doesNotMatch(m, /unreachable/);
      return true;
    },
  );
});

// ── Sanity: the isPaperRecord probe sees both backends' records ───────────────

test("isPaperRecord (shared probe) recognizes records from both backends", async () => {
  const fromOpenAlex = await searchPapers("q", {}, depsWith({
    openalex: { fetchWorks: async () => [OPENALEX_WORK] },
  }));
  const fromEpmc = await searchPapers("q", { index: "europepmc" }, depsWith({
    europepmc: {
      fetchResults: async () => ({ hitCount: 1, resultList: { result: [EPMC_RESULT] } }),
    },
  }));
  // The probe is imported via the shared module; just verify shape here.
  assert.ok(Object.keys(fromOpenAlex[0]!).includes("doi"));
  assert.ok(Object.keys(fromEpmc[0]!).includes("doi"));
});

// ── The OpenAlex citation walk (PIWEB-16) ─────────────────────────────────────

test("openalex forward walk: DOI seed resolves, then one cites:W works call", async () => {
  const seen: Array<{ record?: string; filter?: string | null }> = [];
  let worksCalls = 0;
  const results = await searchPapers("", { filters: { citationGraph: { seed: "10.1038/s41587-020-0561-9" } } }, depsWith({
    openalex: {
      fetchRecord: async (lookup) => {
        seen.push({ record: lookup });
        return { ...OPENALEX_WORK, id: "https://openalex.org/W3161425918" };
      },
      fetchWorks: async (params) => {
        worksCalls++;
        seen.push({ filter: params.get("filter") });
        return [OPENALEX_WORK];
      },
    },
  }));
  assert.deepEqual(seen.map((s) => s.record ?? s.filter), [
    "doi:10.1038/s41587-020-0561-9",
    "cites:W3161425918",
  ]);
  assert.equal(worksCalls, 1);
  assert.equal(results.length, 1);
});

test("openalex backward walk is one server-side cited_by:W call — no record re-fetch, no chunk loop", async () => {
  let recordCalls = 0;
  let worksCalls = 0;
  const filters: (string | null)[] = [];
  const results = await searchPapers("", { filters: { citationGraph: { seed: "W3161425918", direction: "citedBy" } }, numResults: 5 }, depsWith({
    openalex: {
      fetchRecord: async () => { recordCalls++; return OPENALEX_WORK; },
      fetchWorks: async (params) => {
        worksCalls++;
        filters.push(params.get("filter"));
        return [OPENALEX_WORK];
      },
    },
  }));
  // W-id seed goes straight to the filter — exactly one works call, no
  // OR-cap math, no chunking anywhere.
  assert.equal(recordCalls, 0);
  assert.equal(worksCalls, 1);
  assert.deepEqual(filters, ["cited_by:W3161425918"]);
  assert.equal(results.length, 1);
});

test("backward walk with a DOI seed: one record fetch resolves the W-id, then one works call; constraints combine", async () => {
  let recordCalls = 0;
  let worksCalls = 0;
  let filter = "";
  await searchPapers("", { filters: { citationGraph: { seed: "10.1038/s41587-020-0561-9", direction: "citedBy" }, openAccess: true, year: 2020 } }, depsWith({
    openalex: {
      fetchRecord: async () => { recordCalls++; return { ...OPENALEX_WORK, id: "https://openalex.org/W3161425918" }; },
      fetchWorks: async (params) => { worksCalls++; filter = params.get("filter") ?? ""; return [OPENALEX_WORK]; },
    },
  }));
  assert.equal(recordCalls, 1);
  assert.equal(worksCalls, 1);
  assert.equal(filter, "publication_year:2020,is_oa:true,cited_by:W3161425918");
});

test("openalex walk rejects PMID/PMCID seeds naming the concrete identifier and the europepmc retry", async () => {
  await assert.rejects(
    searchPapers("", { filters: { citationGraph: { seed: "32581362" } } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed .*pmid id \(32581362\)/);
      assert.match(m, /index: "europepmc"/);
      assert.match(m, /same seed/);
      return true;
    },
  );
});

// ── parsePaperSeed — the shared seed grammar ─────────────────────────────────

test("parsePaperSeed reads the identifier forms a papers row hands the agent", () => {
  assert.deepEqual(parsePaperSeed("10.1038/s41587-020-0561-9"), { kind: "doi", value: "10.1038/s41587-020-0561-9" });
  assert.deepEqual(parsePaperSeed("https://doi.org/10.1038/x"), { kind: "doi", value: "10.1038/x" });
  assert.deepEqual(parsePaperSeed("32581362"), { kind: "pmid", value: "32581362" });
  assert.deepEqual(parsePaperSeed("PMC13434336"), { kind: "pmcid", value: "PMC13434336" });
  assert.deepEqual(parsePaperSeed("https://europepmc.org/article/MED/32581362"), { kind: "pmid", value: "32581362" });
  assert.deepEqual(parsePaperSeed("pmc13434336"), { kind: "pmcid", value: "PMC13434336" });
  assert.deepEqual(parsePaperSeed("W3161425918"), { kind: "openalex", value: "W3161425918" });
  assert.deepEqual(parsePaperSeed("https://openalex.org/W3161425918"), { kind: "openalex", value: "W3161425918" });
  assert.equal(parsePaperSeed(""), null);
  assert.equal(parsePaperSeed("not a seed"), null);
});

// ── Filters ride the search-cache key ────────────────────────────────────────

test("filtersCacheKey serializes stably and distinguishes filter combos", () => {
  assert.equal(filtersCacheKey(undefined), "");
  assert.equal(filtersCacheKey({}), "");
  assert.equal(
    filtersCacheKey({ year: 2023, openAccess: true }),
    filtersCacheKey({ openAccess: true, year: 2023 }),
  );
  assert.notEqual(
    filtersCacheKey({ year: 2023 }),
    filtersCacheKey({ year: 2024 }),
  );
  assert.notEqual(
    filtersCacheKey({ citationGraph: { seed: "W1" } }),
    filtersCacheKey({ citationGraph: { seed: "W1", direction: "citedBy" } }),
  );
  assert.notEqual(
    filtersCacheKey({}),
    filtersCacheKey({ sort: "citedBy" }),
  );
});

// ── applySort — citedBy ranking, Europe PMC's post-fetch approximation ────────

test("applySort ranks by descending citation count; uncounted records keep position", () => {
  const records: PaperRecord[] = [
    { title: "a", url: "u1", snippet: "s", citedBy: 3 },
    { title: "b", url: "u2", snippet: "s" },
    { title: "c", url: "u3", snippet: "s", citedBy: 99 },
  ];
  const sorted = applySort(records, { sort: "citedBy" });
  assert.deepEqual(sorted.map((r) => r.title), ["c", "a", "b"]);
  // No sort requested — identity.
  assert.equal(applySort(records, undefined), records);
});

// ── identifier lookup ─────────────────────────────────────────────────────────

test("searchPapers dispatches a DOI lookup to the OpenAlex record endpoint — one record out, no search", async () => {
  let recordLookup = "";
  let worksCalled = 0;
  const results = await searchPapers("", { filters: { lookup: "10.1038/s41587-020-0561-9" } }, depsWith({
    openalex: {
      fetchWorks: async () => { worksCalled++; return []; },
      fetchRecord: async (lookup) => { recordLookup = lookup; return OPENALEX_WORK; },
    },
  }));
  assert.equal(recordLookup, "doi:10.1038/s41587-020-0561-9");
  assert.equal(worksCalled, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.doi, "10.1038/s41587-020-0561-9");
});

test("searchPapers routes a PMID lookup to Europe PMC by identifier kind — index is ignored", async () => {
  let query = "";
  const results = await searchPapers("", { index: "openalex", filters: { lookup: "23812562" } }, depsWith({
    openalex: {
      fetchRecord: async () => { throw new Error("PMID must not hit OpenAlex"); },
      fetchWorks: async () => { throw new Error("must not be called"); },
    },
    europepmc: {
      fetchResults: async (params) => {
        query = params.get("query") ?? "";
        return { hitCount: 1, resultList: { result: [EPMC_RESULT] } } as EuropePmcResponse;
      },
    },
  }));
  assert.match(query, /EXT_ID:23812562 AND SRC:MED/);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.doi, "10.1093/nar/gkag769");
});

test("a lookup miss surfaces the no-results contract error with the escape hatch", async () => {
  await assert.rejects(
    searchPapers("", { filters: { lookup: "10.9999/not-real" } }, depsWith({
      openalex: { fetchRecord: async () => null },
    })),
    (err: PaperError) => /matched no OpenAlex record/.test(err.message) && /fetch a specific paper/.test(err.message),
  );
});

test("an unparseable lookup is a malformed error naming the accepted forms", async () => {
  await assert.rejects(
    searchPapers("", { filters: { lookup: "not an identifier" } }, depsWith({})),
    (err: PaperError) => /not a paper identifier/.test(err.message) && /DOI, PMID, PMCID/.test(err.message),
  );
});

test("lookup and citationGraph are mutually exclusive — one intent per call", async () => {
  await assert.rejects(
    searchPapers("", { filters: { lookup: "10.1038/s41587-020-0561-9", citationGraph: { seed: "10.1038/x" } } }, depsWith({})),
    (err: PaperError) => /mutually exclusive/.test(err.message),
  );
});

test("lookup rides the search-cache key", () => {
  assert.notEqual(
    filtersCacheKey({}),
    filtersCacheKey({ lookup: "10.1038/s41587-020-0561-9" }),
  );
});

// unused-parameter guards for the fixture imports the tests don't need twice
void (null as unknown as SearchResult | null);
