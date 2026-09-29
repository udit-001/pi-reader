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
import { searchPapers } from "../search/papers.ts";

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
  // Abstracts are genuinely absent for many works in the REST index — the
  // contract is absent-tolerant, so absence here is correct, not drift.
  if (r.content) assert.ok(r.content.length > 0);
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
