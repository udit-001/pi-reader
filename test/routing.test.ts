// Tests for the intent-aware auto router — the pure decision behind
// provider=auto. The agent expresses intent through params; the router turns
// intent into a provider order. Availability fallback stays internal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAutoRoute } from "../search/search.ts";

test("routing: plain keyword query starts free at DuckDuckGo", () => {
  assert.equal(resolveAutoRoute({}), "ddg-first");
  assert.equal(resolveAutoRoute({ numResults: 5 }), "ddg-first");
});

test("routing: recency alone is DuckDuckGo-compatible (df param), stays free-first", () => {
  assert.equal(resolveAutoRoute({ recency: "week" }), "ddg-first");
});

test("routing: Exa-only intent params route straight to Exa", () => {
  assert.equal(resolveAutoRoute({ category: "github" }), "exa-first");
  assert.equal(resolveAutoRoute({ includeContent: true }), "exa-first");
  assert.equal(resolveAutoRoute({ includeSummary: true }), "exa-first");
  assert.equal(resolveAutoRoute({ domains: ["github.com"] }), "exa-first");
});

test("routing: any Exa-shaped param dominates recency", () => {
  assert.equal(resolveAutoRoute({ recency: "day", category: "news", domains: ["-reddit.com"] }), "exa-first");
});

test("routing: news intent stays Exa-first under auto — the news vertical is explicit-only", () => {
  // `provider: "news"` is never chosen by auto-routing (spec PIWEB-8): broad
  // research must not be silently narrowed by the smaller news engine set.
  assert.equal(resolveAutoRoute({ category: "news" }), "exa-first");
  assert.equal(resolveAutoRoute({ category: "news", recency: "week" }), "exa-first");
});
