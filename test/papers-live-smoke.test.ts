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
  const results = await searchPapers("scikit-learn machine learning", { numResults: 5 });
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
