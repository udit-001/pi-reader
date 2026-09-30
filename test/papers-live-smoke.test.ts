// Live smoke test for the papers vertical — asserts the parse seam against
// the REAL OpenAlex API. Skipped by default (network tests in CI are flaky
// and metered); run explicitly when wire drift is suspected:
//
//   PIWEB_LIVE_SMOKE=1 node --test test/papers-live-smoke.test.ts
//
// Why this exists: fixture tests verify what we believe the wire sends —
// they pass even when OpenAlex changes a field name (the normalizer then
// silently omits the key, absent-tolerant, no test fails). This test is the
// only place wire drift surfaces as a failure instead of a silent gap.
// It asserts the minimum viable record — the keys a reading-list pass
// cannot do without — never the full projection, so projection tuning
// doesn't break it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPapers, OPENALEX_FILTER_FAMILIES, OPENALEX_CITATION_EDGES, OPENALEX_FILTER_PROBE } from "../search/papers.ts";

const live = process.env.PIWEB_LIVE_SMOKE === "1";

test("live: searchPapers returns the deep-research keys the agent reads off a plain search", { skip: !live }, async () => {
  const { results } = await searchPapers("scikit-learn machine learning", { numResults: 5 });
  assert.ok(results.length > 0, "no results — check connectivity or the backend's status");
  const r = results[0]!;

  // The record core — a row missing any of these cannot be cited.
  for (const key of ["title", "url", "snippet", "doi", "year"] as const) {
    assert.notEqual(r[key], undefined, `record missing ${key} — the wire shape drifted`);
  }

  // The deep-research keys, present on a work that carries them. scikit-learn
  // (W2101234009) is the stable anchor: top hit, fully-populated row, free
  // singleton lookup — the same record the fixture tests were trimmed from.
  assert.equal(r.openalexId, "W2101234009", "anchor work changed — pick a new stable record");
  for (const key of ["fwci", "refs", "related", "citationTrend", "field"] as const) {
    assert.notEqual(r[key], undefined, `deep-research key ${key} missing — projection or normalizer drifted`);
  }
  assert.ok((r.refs?.length ?? 0) > 0, "refs empty — referenced_works projection lost");

  // Authority (PIWEB-27): the same guard for the fields that make a company lab
  // distinguishable from a university. A renamed wire field empties every
  // record silently, so the presence check has to live here.
  for (const key of ["institutions", "venueType", "refCount"] as const) {
    assert.notEqual(r[key], undefined, `authority key ${key} missing — projection or normalizer drifted`);
  }
  assert.ok((r.institutions?.length ?? 0) > 0, "institutions empty — authorships.institutions lost");
  const inst = r.institutions![0]!;
  for (const k of ["name", "type", "country", "ror"] as const) {
    assert.notEqual(inst[k], undefined, `institution missing ${k} — the authority mapping drifted`);
  }
  // Dedupe is the invariant that cannot drift falsely: the anchor's raw
  // authorships collapse to unique institutions, whatever their count.
  const names = r.institutions!.map((x) => x.name);
  assert.equal(new Set(names).size, names.length, "institutions came back duplicated — dedupe drifted");
  assert.ok((r.refCount ?? 0) > 0, "refCount empty — referenced_works lost");

  // Abstracts are genuinely absent for many works in the REST index — the
  // contract is absent-tolerant, so absence here is correct, not drift.
  if (r.content) assert.ok(r.content.length > 0);
});

test("live: a genuinely rejected expression surfaces the API's own complaint", { skip: !live }, async () => {
  // readErrorDetail is the only reader of the wire's {"message": …} body, so a
  // renamed field would degrade every malformed error to "the request was
  // rejected" — silently, everywhere, which is the drift class this file
  // exists to catch. An unknown filter field is a real 400 from the real API.
  await assert.rejects(
    searchPapers("q", { filters: { expression: "publication_yearx:2020" } }),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed/, "the 400 stopped reading as malformed");
      assert.match(m, /publication_yearx is not a valid field/, "the API's own complaint stopped arriving — the error body's field name drifted");
      assert.ok(m.length < 600, `the complaint should stay bounded, got ${m.length} chars`);
      return true;
    },
  );
});

test("live: each backend reports the match count behind its page", { skip: !live }, async () => {
  // The envelope prints "showing N of M" off this number, so a renamed wire
  // field (OpenAlex `meta.count`, Europe PMC `hitCount`) would silently drop it
  // everywhere at once. A broad query is the guard: the index matches far more
  // than one page carries.
  const oa = await searchPapers("malaria", { numResults: 3 });
  assert.equal(typeof oa.total, "number", "OpenAlex meta.count stopped arriving");
  assert.ok(oa.total! > oa.results.length, `expected a count above one page, got ${oa.total} for ${oa.results.length} rows`);

  const epmc = await searchPapers("malaria", { index: "europepmc", numResults: 3 });
  assert.equal(typeof epmc.total, "number", "Europe PMC hitCount stopped arriving");
  assert.ok(epmc.total! > epmc.results.length, `expected a count above one page, got ${epmc.total} for ${epmc.results.length} rows`);
});

test("live: a paper already identified comes back as a clause on each adapter", { skip: !live }, async () => {
  // The retired `filters.lookup` mode; its replacement is the identifier
  // constraint, so this is the wire guard for both spellings. The DOI is the
  // anchor: a work whose identifier form the API stops accepting returns an
  // empty page here instead of failing anywhere else.
  const oa = await searchPapers("", { numResults: 5, filters: { expression: "doi:10.1038/nature12373" } });
  assert.equal(oa.results.length, 1, "the identifier clause did not anchor exactly one work");
  assert.equal(oa.results[0]!.doi, "10.1038/nature12373", "the anchored work's DOI drifted");

  // The other clause form the description names — `doi:` and `ids.pmid:` are
  // the two identifier spellings OpenAlex accepts (it has no `ids.pmcid:`: a
  // PMCID filter matches nothing, which is why the description does not name it).
  const pmid = await searchPapers("", { numResults: 5, filters: { expression: "ids.pmid:22955618" } });
  assert.equal(pmid.results.length, 1, "the ids.pmid: clause did not anchor exactly one work");
  assert.equal(pmid.results[0]!.doi, "10.1038/nature11212", "the PMID anchored the wrong work");

  const epmc = await searchPapers('DOI:"10.1038/nature12373"', { index: "europepmc", numResults: 5 });
  assert.equal(epmc.results.length, 1, "Europe PMC's identifier query did not anchor exactly one record");
  assert.equal(epmc.results[0]!.doi, "10.1038/nature12373", "Europe PMC's anchored record drifted");
});

test("live: a multi-seed expression returns rows in one request", { skip: !live }, async () => {
  // The pipe is the API's own or-operator, so expanding two seeds is one
  // request rather than a loop the interface runs (verified live 2026-09-30:
  // 65,591 works cite either anchor).
  const { results } = await searchPapers("", {
    numResults: 5,
    filters: { expression: "cites:W2101234009|W2066783444" },
  });
  assert.ok(results.length > 0, "the pipe or-list returned nothing — the expression path or the filter drifted");
  for (const row of results) {
    for (const key of ["title", "url", "snippet"] as const) {
      assert.notEqual(row[key], undefined, `expression result missing ${key}`);
    }
  }
});

test("live: every filter field the description names is one the API still accepts", { skip: !live }, async () => {
  // The description names a family per field; the API's own catalogue is the
  // source of truth for all 214 it accepts, and the description points at that
  // catalogue rather than copying it. A renamed field would silently narrow
  // what the agent can ask for — this is where that drift fails.
  const res = await fetch("https://api.openalex.org/works?filter=unknown:1&per-page=1");
  const body = (await res.json()) as { message?: string };
  const tail = (body.message ?? "").split("versions of: ")[1] ?? "";
  const catalogue = new Set(tail.split(", ").map((f) => f.trim()));
  assert.ok(catalogue.size > 100, `the API's catalogue did not arrive — got ${catalogue.size} fields`);
  for (const { family, field } of OPENALEX_FILTER_FAMILIES) {
    assert.ok(catalogue.has(field), `family ${family} names ${field}, which the API no longer accepts`);
  }
  for (const { token } of OPENALEX_CITATION_EDGES) {
    assert.ok(catalogue.has(token), `citation edge ${token} is no longer a filter field`);
  }
});

test("live: every filter operator the grammar names is one the API still accepts", { skip: !live }, async () => {
  // The probe exercises every operator in OPENALEX_FILTER_GRAMMAR; a dropped
  // operator or a renamed field makes the API 400 here instead of silently
  // narrowing what the agent can write. The unit test pins the probe against
  // the grammar; this pins it against the wire.
  const { results } = await searchPapers("", { numResults: 3, filters: { expression: OPENALEX_FILTER_PROBE } });
  assert.ok(results.length > 0, "the operator probe returned nothing — an operator or field drifted");
});

test("live: a cursor enumerates a result set past one page with no duplicates", { skip: !live }, async () => {
  const first = await searchPapers("scikit-learn machine learning", { numResults: 3, filters: { cursor: "*" } });
  assert.ok(first.nextCursor, "no meta.next_cursor returned — OpenAlex pagination drifted");
  const second = await searchPapers("scikit-learn machine learning", {
    numResults: 3,
    filters: { cursor: first.nextCursor },
  });
  assert.ok(second.results.length > 0, "the second page came back empty — cursor lost or stale");
  const firstIds = new Set(first.results.map((x) => x.openalexId));
  for (const r2 of second.results) {
    assert.equal(firstIds.has(r2.openalexId), false, `row ${r2.openalexId} repeated across pages`);
  }
  // The point of the walk: two pages carry more rows than one. A cursor that
  // silently stopped advancing would still pass the no-duplicates check.
  const union = new Set([...first.results, ...second.results].map((x) => x.openalexId));
  assert.ok(union.size > first.results.length, "the second page added no rows — enumeration is not advancing");
});

// The Europe PMC half of the same guard: its walk endpoints page by offset and
// its search endpoint by cursor, and both were verified live on 2026-09-30
// (pageSize 1000 serves, 1001 returns HTTP 200 with zero rows and no hitCount;
// `page` is ignored outright on /search). PMID 32581362 is the stable anchor —
// a 59-entry reference list, long enough to cross a page boundary without
// asking for a page size the tool's ceiling would reject.
test("live: a Europe PMC reference list enumerates past one page by offset", { skip: !live }, async () => {
  const walk = (page: number) => searchPapers("", {
    index: "europepmc",
    numResults: 30,
    page,
    filters: { citationGraph: { seed: "32581362", direction: "citedBy" } },
  });
  const first = await walk(1);
  assert.equal(first.results.length, 30, "the first page came up short — the walk lost its pageSize");
  const second = await walk(2);
  assert.ok(second.results.length > 0, "page 2 is empty — offset paging drifted");
  const firstTitles = new Set(first.results.map((x) => x.title));
  for (const r2 of second.results) {
    assert.equal(firstTitles.has(r2.title), false, `entry "${r2.title}" repeated across pages — page is not reaching the API`);
  }
});

test("live: Europe PMC's search cursor continues the enumeration it opened", { skip: !live }, async () => {
  const first = await searchPapers("malaria", { index: "europepmc", numResults: 5, filters: { cursor: "*" } });
  assert.ok(first.nextCursor, "no nextCursorMark returned — Europe PMC's cursor drifted");
  const second = await searchPapers("malaria", { index: "europepmc", numResults: 5, filters: { cursor: first.nextCursor } });
  assert.ok(second.results.length > 0, "the cursor's second page came back empty");
  const firstUrls = new Set(first.results.map((x) => x.url));
  for (const r2 of second.results) {
    assert.equal(firstUrls.has(r2.url), false, `row ${r2.url} repeated across pages`);
  }
});

test("live: an ordinary Europe PMC search is not handed a cursor", { skip: !live }, async () => {
  // Europe PMC ships nextCursorMark on every search response, cursor mode or
  // not — so this pins the adapter's gate, not the API's shape. Without it
  // every ordinary search prints a Next cursor line and, because a
  // cursor-bearing response is never cached, loses the search cache.
  const plain = await searchPapers("malaria", { index: "europepmc", numResults: 5 });
  assert.equal("nextCursor" in plain, false, "the adapter leaked the wire's always-present cursorMark");
});

// The Europe PMC query-language half of PIWEB-38: synonym expansion is the
// backend's recall lever, and both sorts are the index's rather than the
// fetched page's. Verified live 2026-09-30 — `"heart attack"` returns 54,785
// with synonyms off and 755,190 with them on; `CITED desc` on malaria puts the
// 14,722-citation row first where relevance returns uncited ones.
test("live: Europe PMC's synonym expansion widens the set by an order of magnitude", { skip: !live }, async () => {
  const exact = await searchPapers('"heart attack"', { index: "europepmc", numResults: 5 });
  const expanded = await searchPapers('"heart attack"', { index: "europepmc", numResults: 5, filters: { synonym: true } });
  assert.ok(
    (expanded.total ?? 0) > (exact.total ?? 0),
    `synonym expansion did not widen the set — exact ${exact.total}, expanded ${expanded.total}`,
  );
  assert.ok(
    (expanded.total ?? 0) > 100_000,
    `the order-of-magnitude difference is gone (expanded ${expanded.total}) — the synonym wire changed`,
  );
});

test("live: Europe PMC's sort orders the whole index, not the fetched page", { skip: !live }, async () => {
  const cited = await searchPapers("malaria", { index: "europepmc", numResults: 10, filters: { sort: "citedBy" } });
  const counts = cited.results.map((r) => r.citedBy ?? -1);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1]! >= counts[i]!, `citedBy sort is not descending at ${i}: ${counts.join(", ")}`);
  }
  assert.ok((counts[0] ?? 0) > 0, "the top row carries no citation count — the sort or the citedByCount field drifted");

  const newest = await searchPapers("malaria", { index: "europepmc", numResults: 10, filters: { sort: "date" } });
  const years = newest.results.map((r) => r.year ?? 0);
  for (let i = 1; i < years.length; i++) {
    assert.ok(years[i - 1]! >= years[i]!, `date sort is not newest-first at ${i}: ${years.join(", ")}`);
  }
});
