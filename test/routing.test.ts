// Tests for the intent-aware auto router — the pure decision behind
// provider=auto. The agent expresses intent through params; the router turns
// intent into a provider order. Availability fallback stays internal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAutoRoute, autoChain } from "../search/search.ts";

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

// ── autoChain — the full auto pair: [primary, failure-fallback] ───────────

 test("autoChain: news intent runs the fidelity ladder — Exa primary, news vertical on failure", () => {
  // Exa stays primary for news intent when alive (PIWEB-10); the failure leg
  // is the news vertical, whose own degrade lands on text — not a direct
  // drop to generic text.
  assert.deepEqual(autoChain({ category: "news" }), ["exa", "news"]);
  assert.deepEqual(autoChain({ category: "news", recency: "week" }), ["exa", "news"]);
});

test("autoChain: non-news intents keep today's fallback pair", () => {
  assert.deepEqual(autoChain({}), ["duckduckgo", "exa"]);
  assert.deepEqual(autoChain({ recency: "week" }), ["duckduckgo", "exa"]);
  assert.deepEqual(autoChain({ category: "github" }), ["exa", "duckduckgo"]);
  assert.deepEqual(autoChain({ includeContent: true }), ["exa", "duckduckgo"]);
  assert.deepEqual(autoChain({ domains: ["github.com"] }), ["exa", "duckduckgo"]);
});
