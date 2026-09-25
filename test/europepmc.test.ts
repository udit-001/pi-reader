// Tests for the Europe PMC papers backend — index: "europepmc".
// Pure seams only: flag/author parsing, URL/OA choice, the normalizer (same
// PaperRecord shape as OpenAlex), request params, and the adapter's deps
// flow. Fixture is a trimmed live capture (2026-09-25,
// europepmc/webservices/rest/search?query=CRISPR base editing). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFlagY,
  parseAuthors,
  chooseRecordUrl,
  chooseOaUrl,
  normalizeEuropePmcResults,
  buildEuropePmcParams,
  searchEuropePmc,
  type EuropePmcResult,
  type EuropePmcResponse,
} from "../search/europepmc.ts";
import { PaperError } from "../search/paper-backend.ts";

// ── Fixtures — trimmed live capture (2026-09-25) ─────────────────────────────

// PubMed record: PMID, doi, journal info, closed access, no PMC copy.
const PUBMED_REC: EuropePmcResult = {
  id: "42527584",
  source: "MED",
  pmid: "42527584",
  doi: "10.1038/s41551-026-01747-y",
  title: "In vivo CRISPR base editing for treatment of Huntington's disease.",
  authorString: "Shirguppe S, Gapinske M, Swami D, Gaj T, Perez-Pinera P.",
  journalTitle: "Nat Biomed Eng",
  journalInfo: { journal: { title: "Nature Biomedical Engineering" } },
  pubYear: "2026",
  pubType: "journal article",
  isOpenAccess: "N",
  inEPMC: "N",
  inPMC: "N",
  citedByCount: 0,
  firstPublicationDate: "2026-07-29",
};

// PMC record: full text in Europe PMC, OA tag Y, citedByCount present.
const PMC_REC: EuropePmcResult = {
  id: "42549577",
  source: "MED",
  pmid: "42549577",
  pmcid: "PMC13434336",
  doi: "10.1093/nar/gkag769",
  title: "BASELINE: a CRISPR base editing platform for mammalian-scale single-cell lineage tracing.",
  authorString: "Winter E, Emiliani F, McKenna A.",
  journalTitle: "Nucleic Acids Res",
  journalInfo: { journal: { title: "Nucleic Acids Research" } },
  pubYear: "2026",
  pubType: "research-article; journal article",
  isOpenAccess: "Y",
  inEPMC: "Y",
  inPMC: "Y",
  citedByCount: 3,
  firstPublicationDate: "2026-07-01",
};

// A patent-style record: no doi, no journal — Europe PMC record page by
// source+id is the only URL.
const PATENT_REC: EuropePmcResult = {
  id: "3540589",
  source: "PAT",
  title: "Base editing of genomic DNA",
  authorString: "Liu D.",
  pubYear: "2025",
  isOpenAccess: "Y",
  inEPMC: "Y",
  citedByCount: 0,
};

const RESPONSE: EuropePmcResponse = {
  hitCount: 53631,
  resultList: { result: [PUBMED_REC, PMC_REC, PATENT_REC] },
};

// ── isFlagY / parseAuthors — the shape-shifting primitives ───────────────────

test("isFlagY reads only the Y flag", () => {
  assert.equal(isFlagY("Y"), true);
  assert.equal(isFlagY(undefined), false);
  assert.equal(isFlagY("N"), false);
});

test("parseAuthors splits the comma string and drops empties", () => {
  assert.deepEqual(parseAuthors("Winter E, Emiliani F, Cook A"), ["Winter E", "Emiliani F", "Cook A"]);
  assert.deepEqual(parseAuthors("Liu D."), ["Liu D."]);
  assert.equal(parseAuthors(undefined), undefined);
  assert.equal(parseAuthors(""), undefined);
});

// ── chooseRecordUrl / chooseOaUrl — the two URL decisions ─────────────────────

test("europepmc chooseRecordUrl prefers doi.org, then PMC copy, then the source+id record page", () => {
  assert.equal(chooseRecordUrl(PUBMED_REC), "https://doi.org/10.1038/s41551-026-01747-y");
  assert.equal(chooseRecordUrl(PATENT_REC), "https://europepmc.org/article/PAT/3540589");
  assert.equal(chooseRecordUrl({}), null);
});

test("europepmc chooseOaUrl returns the PMC full-text body only when a copy exists", () => {
  assert.equal(chooseOaUrl(PMC_REC), "https://europepmc.org/article/PMC13434336");
  assert.equal(chooseOaUrl(PUBMED_REC), null);
  // inPMC=Y without inEPMC=Y → the NCBI copy.
  assert.equal(
    chooseOaUrl({ pmcid: "PMC123", inPMC: "Y" }),
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/",
  );
  // An OA-flagged record with no id at all — no URL anchor, no oaUrl.
  assert.equal(chooseOaUrl({ inEPMC: "Y" }), null);
});

// ── normalizeEuropePmcResults — same record shape as OpenAlex ─────────────────

test("europepmc normalizer maps the same flat keys the OpenAlex backend emits", () => {
  const [pubmed, pmc] = normalizeEuropePmcResults([PUBMED_REC, PMC_REC]);
  assert.deepEqual(
    { title: pmc!.title, url: pmc!.url, year: pmc!.year, authors: pmc!.authors, venue: pmc!.venue, citedBy: pmc!.citedBy, doi: pmc!.doi, oaUrl: pmc!.oaUrl },
    {
      title: "BASELINE: a CRISPR base editing platform for mammalian-scale single-cell lineage tracing.",
      url: "https://doi.org/10.1093/nar/gkag769",
      year: 2026,
      authors: ["Winter E", "Emiliani F", "McKenna A."],
      venue: "Nucleic Acids Research",
      citedBy: 3,
      doi: "10.1093/nar/gkag769",
      oaUrl: "https://europepmc.org/article/PMC13434336",
    },
  );
  // Closed record: year is a number, oaUrl absent, snippet says closed.
  assert.equal(pubmed!.year, 2026);
  assert.equal("oaUrl" in pubmed!, false);
});

test("europepmc normalizer builds the snippet from the shared builder — venue before journalTitle", () => {
  const [pubmed, pmc, patent] = normalizeEuropePmcResults([PUBMED_REC, PMC_REC, PATENT_REC]);
  assert.equal(
    pubmed!.snippet,
    "Nature Biomedical Engineering · 2026 · 0 citations · closed · Shirguppe S et al.",
  );
  assert.equal(
    pmc!.snippet,
    "Nucleic Acids Research · 2026 · 3 citations · open · Winter E et al.",
  );
  assert.equal(patent!.snippet, "2025 · 0 citations · open · Liu D.");
});

test("europepmc normalizer falls back to journalTitle when journalInfo carries no title", () => {
  const [r] = normalizeEuropePmcResults([{
    ...PUBMED_REC,
    journalInfo: undefined,
    doi: undefined,
    pmcid: undefined,
  }]);
  assert.equal(r!.venue, "Nat Biomed Eng");
  assert.equal(r!.url, "https://europepmc.org/article/MED/42527584");
});

test("europepmc normalizer tolerates missing fields — no invented keys", () => {
  const [r] = normalizeEuropePmcResults([{ title: "bare", id: "1", source: "MED" }]);
  assert.equal("year" in r!, false);
  assert.equal("authors" in r!, false);
  assert.equal("venue" in r!, false);
  assert.equal("citedBy" in r!, false);
  assert.equal("doi" in r!, false);
  assert.equal("oaUrl" in r!, false);
});

test("europepmc normalizer drops records with no record URL — no url, no action", () => {
  const results = normalizeEuropePmcResults([{ title: "no url anywhere" }, PATENT_REC]);
  assert.deepEqual(results.map((r) => r.title), [PATENT_REC.title]);
});

test("europepmc normalizer returns an empty array for empty input", () => {
  assert.deepEqual(normalizeEuropePmcResults([]), []);
});

// ── buildEuropePmcParams — query, format, pageSize ────────────────────────────

test("europepmc params carry the query, json format, and page size", () => {
  const p = buildEuropePmcParams("CRISPR base editing", 10);
  assert.equal(p.get("query"), "CRISPR base editing");
  assert.equal(p.get("format"), "json");
  assert.equal(p.get("pageSize"), "10");
});

// ── searchEuropePmc — deps flow, slicing, in-band error shaping ──────────────

function depsWith(overrides: Partial<EuropePmcDeps>): EuropePmcDeps {
  return {
    fetchResults: async () => RESPONSE,
    ...overrides,
  };
}

test("searchEuropePmc returns normalized records on the happy path", async () => {
  const results = await searchEuropePmc("CRISPR base editing", {}, depsWith({}));
  assert.equal(results.length, 3);
  assert.equal(results[0]!.doi, "10.1038/s41551-026-01747-y");
  assert.equal(results[1]!.oaUrl, "https://europepmc.org/article/PMC13434336");
});

test("searchEuropePmc passes the query, pageSize, and signal through to the fetch", async () => {
  const seen: Array<{ params: URLSearchParams; signal?: AbortSignal }> = [];
  const signal = new AbortController().signal;
  await searchEuropePmc("prime editing", { numResults: 7, signal }, depsWith({
    fetchResults: async (params, sig) => {
      seen.push({ params, signal: sig });
      return { hitCount: 1, resultList: { result: [PMC_REC] } };
    },
  }));
  assert.equal(seen[0]!.params.get("query"), "prime editing");
  assert.equal(seen[0]!.params.get("pageSize"), "7");
  assert.equal(seen[0]!.signal, signal);
});

test("searchEuropePmc slices results to numResults", async () => {
  const results = await searchEuropePmc("q", { numResults: 1 }, depsWith({}));
  assert.equal(results.length, 1);
});

test("searchEuropePmc wraps fetch failures as backend-down — retry index named", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 503"); },
    })),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /Europe PMC was unreachable/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("searchEuropePmc surfaces a 400 response as the malformed case, not backend-down", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 400"); },
    })),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed \(Europe PMC returned 400\)/);
      assert.doesNotMatch(m, /unreachable/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("searchEuropePmc keeps 429 rate-limiting in the backend-down bucket, not malformed", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 429"); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /unreachable/);
      assert.doesNotMatch(m, /malformed/);
      return true;
    },
  );
});

test("searchEuropePmc throws no-results on an empty hitList — distinguished from backend-down", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({ fetchResults: async () => ({ hitCount: 0, resultList: { result: [] } }) })),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /returned no results/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});
