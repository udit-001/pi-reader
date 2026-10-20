// Tests for the Parallel MCP adapter's parse seams and error classification,
// using fixtures that mirror what the remote server actually returns (live
// anonymous-tier probe: sanitized JSON with search_id, url, title,
// publish_date, excerpts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyParallelError, parseParallelResults } from "../search/parallel-mcp.ts";

test("parallel: parses sanitized web_search JSON", () => {
  const json = JSON.stringify({
    search_id: "search_abc123",
    results: [
      {
        url: "https://stripe.com/pricing",
        title: "Pricing & Fees - Stripe",
        publish_date: "2026-01-15",
        excerpts: ["Standard: pay-as-you-go pricing.", "No setup fees, no monthly fees."],
      },
      {
        url: "https://docs.example.com/billing",
        title: "Billing docs",
        publish_date: null,
        excerpts: ["API integration pricing table."],
      },
    ],
  });

  const results = parseParallelResults(json);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Pricing & Fees - Stripe");
  assert.equal(results[0]!.url, "https://stripe.com/pricing");
  assert.equal(results[0]!.publishedDate, "2026-01-15");
  // Excerpts join into one whitespace-normalized snippet.
  assert.equal(results[0]!.snippet, "Standard: pay-as-you-go pricing. No setup fees, no monthly fees.");
  // null publish_date is absent, not the string "null".
  assert.equal(results[1]!.publishedDate, undefined);
});

test("parallel: snippet is capped at 500 chars like other providers", () => {
  const json = JSON.stringify({
    results: [{ url: "https://x.example.com", title: "X", publish_date: null, excerpts: ["a".repeat(600)] }],
  });
  const [row] = parseParallelResults(json);
  assert.equal(row!.snippet.length, 500);
});

test("parallel: rows without a url are dropped", () => {
  const json = JSON.stringify({
    results: [
      { url: "", title: "no url", publish_date: null, excerpts: ["x"] },
      { title: "missing url key", publish_date: null, excerpts: ["y"] },
      { url: "https://ok.example.com", title: "ok", publish_date: null, excerpts: ["z"] },
    ],
  });
  const results = parseParallelResults(json);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, "https://ok.example.com");
});

test("parallel: non-JSON and missing-results responses throw", () => {
  assert.throws(() => parseParallelResults("<html>gateway error</html>"), /non-JSON/);
  assert.throws(() => parseParallelResults(JSON.stringify({ search_id: "x" })), /no results array/);
  assert.throws(() => parseParallelResults(JSON.stringify({ results: [] })), /no parseable results/);
});

test("parallel: rate-limit errors classify; connection noise does not", () => {
  assert.equal(classifyParallelError("HTTP 429: too many requests"), "rate-limited");
  assert.equal(classifyParallelError("Rate limit exceeded for session"), "rate-limited");
  assert.equal(classifyParallelError("quota exhausted"), "rate-limited");
  // A 401 (bad key) or a network blip is not a rate-limit issue.
  assert.equal(classifyParallelError("HTTP 401: unauthorized"), null);
  assert.equal(classifyParallelError("fetch failed"), null);
});
