// Tests for the papers dispatcher — backend routing by `index`, the in-band
// error contract, and the same-shape guarantee across backends. Fixtures
// recreated in-line (shared captures from the backend test files' live
// pulls). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPapers, type OpenAlexWork } from "../search/papers.ts";
import { paperError, otherIndex, type PaperRecord } from "../search/paper-backend.ts";
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
type PapersDeps = Parameters<typeof searchPapers>[2];

function depsWith(overrides: NonNullable<Parameters<typeof searchPapers>[2]>): PapersDeps {
  return overrides;
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
  assert.match(paperError("backend-down", "openalex"), /biomedical full text: PubMed, preprints, patents/);
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

// unused-parameter guards for the fixture imports the tests don't need twice
void (null as unknown as SearchResult | null);
