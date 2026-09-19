// Tests for the pure decision seams behind provider=auto. The agent expresses
// intent through params; the seams turn intent into a provider chain.
// autoChain is the single routing seam: [primary, failure-fallback] names.
// Availability fallback stays internal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { autoChain, shouldCacheSearch, type SearchResponse } from "../search/search.ts";

test("autoChain: plain keyword query starts free at DuckDuckGo", () => {
  assert.deepEqual(autoChain({}), ["duckduckgo", "exa"]);
  assert.deepEqual(autoChain({ numResults: 5 }), ["duckduckgo", "exa"]);
});

test("autoChain: recency alone is DuckDuckGo-compatible (df param), stays free-first", () => {
  assert.deepEqual(autoChain({ recency: "week" }), ["duckduckgo", "exa"]);
});

test("autoChain: Exa-only intent params route straight to Exa", () => {
  assert.deepEqual(autoChain({ category: "github" }), ["exa", "duckduckgo"]);
  assert.deepEqual(autoChain({ includeContent: true }), ["exa", "duckduckgo"]);
  assert.deepEqual(autoChain({ includeSummary: true }), ["exa", "duckduckgo"]);
  assert.deepEqual(autoChain({ domains: ["github.com"] }), ["exa", "duckduckgo"]);
});

test("autoChain: any Exa-shaped param dominates recency", () => {
  assert.deepEqual(autoChain({ recency: "day", category: "news", domains: ["-reddit.com"] }), ["exa", "news"]);
});

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

test("autoChain: images intent never enters the chain — explicit provider only", () => {
  // `provider: "images"` is a deliberate dispatch, not an intent the router
  // guesses. No param combination routes to or falls back to images.
  for (const options of [
    {},
    { category: "news" as const },
    { category: "github" as const },
    { includeContent: true, domains: ["github.com"] },
    { license: "commercial" as const },
  ]) {
    const [primary, fallback] = autoChain(options);
    assert.notEqual(primary, "images");
    assert.notEqual(fallback, "images");
  }
});

// ── shouldCacheSearch — the cache-honesty decision ───────────────────────────

const ok = (over: Partial<SearchResponse> = {}): SearchResponse => ({
  answer: "a",
  results: [{ title: "t", url: "https://e.com", snippet: "s" }],
  provider: "duckduckgo",
  ...over,
});

test("shouldCacheSearch: successful free-provider results are cached", () => {
  assert.equal(shouldCacheSearch(ok()), true);
  assert.equal(shouldCacheSearch(ok({ provider: "news" })), true);
  assert.equal(shouldCacheSearch(ok({ provider: "duckduckgo" })), true);
  assert.equal(shouldCacheSearch(ok({ provider: "images" })), true);
});

test("shouldCacheSearch: Exa results are never cached — they cost quota", () => {
  assert.equal(shouldCacheSearch(ok({ provider: "exa" })), false);
  assert.equal(shouldCacheSearch(ok({ provider: "exa" })), false);
});

test("shouldCacheSearch: empty results are never cached", () => {
  assert.equal(shouldCacheSearch(ok({ results: [] })), false);
});

test("shouldCacheSearch: a degraded response is never cached — the flag travels on the response", () => {
  // The news adapter sets degraded when it fell to text; the cache guard reads
  // the flag instead of re-deriving which provider names mean "degraded".
  assert.equal(shouldCacheSearch(ok({ degraded: true })), false);
});
