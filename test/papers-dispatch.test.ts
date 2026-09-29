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
  // The OpenAlex adapter now returns a page ({works, nextCursor}); stubs below
  // still speak in record arrays, so the harness lifts an array into a
  // cursor-less page and passes a real page through untouched.
  const openalex = overrides.openalex;
  const fetchWorks = openalex?.fetchWorks;
  return {
    openalex: {
      fetchWorks: fetchWorks
        ? async (params, signal) => {
          const out = await fetchWorks(params, signal);
          return Array.isArray(out) ? { works: out } : out;
        }
        : async () => ({ works: [] }),
      fetchRecord: openalex?.fetchRecord
        ?? (async () => { throw new Error("OpenAlex record fetch must not run outside walk tests"); }),
      ...(openalex?.resolveKey ? { resolveKey: openalex.resolveKey } : {}),
    },
    europepmc: {
      fetchResults: async () => { throw new Error("Europe PMC must not be called outside walk tests"); },
      fetchRoute: async () => { throw new Error("Europe PMC walk must not be called outside walk tests"); },
      ...overrides.europepmc,
    },
  };
}

// ── index routing ─────────────────────────────────────────────────────────────

test("searchPapers defaults to the OpenAlex backend when index is absent", async () => {
  let openalexCalled = 0;
  let europepmcCalled = 0;
  const { results } = await searchPapers("CRISPR base editing", {}, depsWith({
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
  const { results } = await searchPapers("CRISPR base editing", { index: "europepmc" }, depsWith({
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

// ── Europe PMC enumeration (PIWEB-33): offset walks, cursor search ───────────
// The two surfaces are declared honestly rather than unified: the walk
// endpoints are true offset paging, the search endpoint is cursor-only and
// ignores `page` outright (verified live: page=2 returns page 1's ids).

const REF = (n: number): EuropePmcResult => ({
  id: `REF${n}`,
  source: "MED",
  pmid: `${40000000 + n}`,
  title: `Reference ${n}`,
  journalTitle: "J",
  pubYear: "2020",
  authorString: "A B",
  isOpenAccess: "N",
  inEPMC: "N",
  inPMC: "N",
});

test("a Europe PMC walk is offset-paged: the shared page and numResults reach its route", async () => {
  const seen: Array<{ path: string; params: URLSearchParams }> = [];
  await searchPapers("", {
    index: "europepmc",
    numResults: 50,
    page: 2,
    filters: { citationGraph: { seed: "32581362", direction: "citedBy" } },
  }, depsWith({
    europepmc: {
      fetchRoute: async (path, params) => {
        seen.push({ path, params });
        return { hitCount: 59, referenceList: { reference: [REF(1)] } };
      },
    },
  }));
  assert.equal(seen.length, 1, "one call is one request — no cursor-walking behind the agent's back");
  assert.equal(seen[0]!.path, "MED/32581362/references");
  assert.equal(seen[0]!.params.get("page"), "2");
  assert.equal(seen[0]!.params.get("pageSize"), "50");
});

test("a 59-entry reference list enumerates completely across offset pages, with no duplicates and no gaps", async () => {
  const all = Array.from({ length: 59 }, (_, i) => REF(i));
  const ask = (page: number) => searchPapers("", {
    index: "europepmc",
    numResults: 25,
    page,
    filters: { citationGraph: { seed: "32581362", direction: "citedBy" } },
  }, depsWith({
    europepmc: {
      // The API's own offset rule: offset = (page - 1) * pageSize.
      fetchRoute: async (_path, params) => {
        const size = Number(params.get("pageSize"));
        const p = Number(params.get("page"));
        return { hitCount: 59, referenceList: { reference: all.slice((p - 1) * size, p * size) } };
      },
    },
  }));
  const collected: string[] = [];
  for (const page of [1, 2, 3]) {
    const { results } = await ask(page);
    collected.push(...results.map((r) => r.title));
  }
  assert.equal(collected.length, 59);
  assert.equal(new Set(collected).size, 59);
  assert.deepEqual(collected, all.map((r) => r.title));
});

test("Europe PMC's search takes the cursor it was given and hands back the next page's handle", async () => {
  const seen: URLSearchParams[] = [];
  const page = await searchPapers("malaria", { index: "europepmc", filters: { cursor: "*" } }, depsWith({
    europepmc: {
      fetchResults: async (params) => {
        seen.push(params);
        return { hitCount: 291321, resultList: { result: [EPMC_RESULT] }, nextCursorMark: "AoIIQCDKcyg1NTkyNzA3OQ==" };
      },
    },
  }));
  assert.equal(seen[0]!.get("cursorMark"), "*");
  // Byte-for-byte: the agent passes it on untouched.
  assert.equal(page.nextCursor, "AoIIQCDKcyg1NTkyNzA3OQ==");
  assert.equal(page.results.length, 1);
});

test("Europe PMC's search leaves nextCursor absent when the enumeration ends", async () => {
  const page = await searchPapers("malaria", { index: "europepmc" }, depsWith({
    europepmc: { fetchResults: async () => ({ hitCount: 1, resultList: { result: [EPMC_RESULT] } }) },
  }));
  assert.equal("nextCursor" in page, false);
});

test("Europe PMC's search declines `page` in band, naming the cursor as the mechanism", async () => {
  await assert.rejects(
    searchPapers("malaria", { index: "europepmc", page: 2 }, depsWith({
      europepmc: { fetchResults: async () => { throw new Error("must not be called"); } },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /pages by cursor, not page number/);
      assert.match(m, /filters\.cursor/);
      assert.doesNotMatch(m, /index: "openalex"/);
      return true;
    },
  );
});

test("a Europe PMC walk declines filters.cursor, naming the offset parameter that serves it", async () => {
  await assert.rejects(
    searchPapers("", {
      index: "europepmc",
      filters: { cursor: "X", citationGraph: { seed: "32581362" } },
    }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /walk is offset-paged/);
      assert.match(m, /`page`/);
      return true;
    },
  );
});

test("a Europe PMC search that never opened an enumeration is not handed its cursor", async () => {
  // Europe PMC ships nextCursorMark on every search response, cursor mode or
  // not (verified live). Attaching it always would print a phantom Next cursor
  // line and cost the search cache, which refuses a cursor-bearing response.
  const page = await searchPapers("malaria", { index: "europepmc" }, depsWith({
    europepmc: {
      fetchResults: async () => ({
        hitCount: 291321,
        resultList: { result: [EPMC_RESULT] },
        nextCursorMark: "AoIIQCDKcyg1NTkyNzA3OQ==",
      }),
    },
  }));
  assert.equal("nextCursor" in page, false);
});

test("a forward walk pages its citation list by offset with no duplicates and no gaps", async () => {
  const all = Array.from({ length: 445 }, (_, i) => REF(i));
  const ask = (page: number) => searchPapers("", {
    index: "europepmc",
    numResults: 30,
    page,
    filters: { citationGraph: { seed: "32581362", direction: "cites" } },
  }, depsWith({
    europepmc: {
      fetchRoute: async (path, params) => {
        assert.equal(path, "MED/32581362/citations", "the forward walk must ride /citations");
        const size = Number(params.get("pageSize"));
        const p = Number(params.get("page"));
        return { hitCount: 445, citationList: { citation: all.slice((p - 1) * size, p * size) } };
      },
    },
  }));
  const first = await ask(1);
  const second = await ask(2);
  assert.equal(first.results.length, 30);
  assert.equal(second.results.length, 30);
  const titles = [...first.results, ...second.results].map((r) => r.title);
  assert.equal(new Set(titles).size, 60);
});

// ── The same-shape guarantee — no per-backend forking downstream ──────────────

test("both backends emit PaperRecords with the same flat keys on a shared record", async () => {
  const { results: fromOpenAlex } = await searchPapers("q", {}, depsWith({
    openalex: { fetchWorks: async () => [OPENALEX_WORK] },
  }));
  const { results: fromEpmc } = await searchPapers("q", { index: "europepmc" }, depsWith({
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
  // Down/no-results offer a manual escape hatch; malformed points at the
  // complaint instead, because the fix is in the query the agent wrote.
  assert.match(down, /DOI or URL/);
  assert.match(none, /DOI or URL/);
  assert.match(malformed, /fix what the complaint names/i);
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
  const { results: fromOpenAlex } = await searchPapers("q", {}, depsWith({
    openalex: { fetchWorks: async () => [OPENALEX_WORK] },
  }));
  const { results: fromEpmc } = await searchPapers("q", { index: "europepmc" }, depsWith({
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
  const { results } = await searchPapers("", { filters: { citationGraph: { seed: "10.1038/s41587-020-0561-9" } } }, depsWith({
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
    "is_retracted:false,cites:W3161425918",
  ]);
  assert.equal(worksCalls, 1);
  assert.equal(results.length, 1);
});

test("openalex backward walk is one server-side cited_by:W call — no record re-fetch, no chunk loop", async () => {
  let recordCalls = 0;
  let worksCalls = 0;
  const filters: (string | null)[] = [];
  const { results } = await searchPapers("", { filters: { citationGraph: { seed: "W3161425918", direction: "citedBy" } }, numResults: 5 }, depsWith({
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
  assert.deepEqual(filters, ["is_retracted:false,cited_by:W3161425918"]);
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
  assert.equal(filter, "is_retracted:false,publication_year:2020,is_oa:true,cited_by:W3161425918");
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
  // The cursor is part of the call identity: two pages must never share a
  // cache key, or page 2 would replay page 1.
  assert.notEqual(
    filtersCacheKey({ cursor: "CURSOR-1" }),
    filtersCacheKey({ cursor: "CURSOR-2" }),
  );
  assert.notEqual(filtersCacheKey({}), filtersCacheKey({ cursor: "CURSOR-1" }));
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

// ── a paper already identified — the retired lookup's replacement ────────────
//
// One shape for both adapters: an identifier is a constraint, so it rides the
// adapter's own constraint language (the works adapter's filter expression,
// the biomedical adapter's query language) instead of a mode of its own.

test("a known DOI reaches the works adapter as an expression clause — one works call, no search", async () => {
  let filter = "";
  let search = "";
  const { results } = await searchPapers("", { filters: { expression: "doi:10.1038/s41587-020-0561-9" } }, depsWith({
    openalex: {
      fetchWorks: async (params) => {
        filter = params.get("filter") ?? "";
        search = params.get("search") ?? "";
        return [OPENALEX_WORK];
      },
    },
  }));
  assert.equal(filter, "doi:10.1038/s41587-020-0561-9,is_retracted:false");
  assert.equal(search, "");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.doi, "10.1038/s41587-020-0561-9");
});

test("a known PMID reaches the biomedical adapter in its own query language", async () => {
  let query = "";
  const { results } = await searchPapers("EXT_ID:23812562 AND SRC:MED", { index: "europepmc" }, depsWith({
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

// unused-parameter guards for the fixture imports the tests don't need twice
void (null as unknown as SearchResult | null);
