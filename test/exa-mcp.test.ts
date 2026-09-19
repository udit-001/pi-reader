// Tests for the Exa MCP adapter's parse seams, using fixtures that mirror
// what the remote server actually returns (formatted text + sanitized JSON).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormattedResults, parseJsonResults, parseCrawlResults } from "../search/exa-mcp.ts";

test("exa: parses formatted web_search_exa result blocks", () => {
  const text = [
    "Title: Example Blog: Why We Moved",
    "URL: https://blog.example.com/why-we-moved",
    "Published: 2026-01-15T10:00:00.000Z",
    "Author: Ada Lovelace",
    "Highlights:",
    "We moved to a new stack for three reasons. The first reason was cost.",
    "---",
    "Title: Example Corp Engineering",
    "URL: https://eng.example.com/posts/migration",
    "Highlights:",
    "Migration guide with a detailed comparison table.",
  ].join("\n");

  const results = parseFormattedResults(text);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Example Blog: Why We Moved");
  assert.equal(results[0]!.url, "https://blog.example.com/why-we-moved");
  assert.equal(results[0]!.publishedDate, "2026-01-15T10:00:00.000Z");
  assert.equal(results[0]!.author, "Ada Lovelace");
  assert.ok(results[0]!.snippet.includes("cost"));
  assert.equal(results[1]!.url, "https://eng.example.com/posts/migration");
});

test("exa: parses advanced search JSON with results array", () => {
  const json = JSON.stringify({
    results: [
      {
        title: "Rust Async Patterns",
        url: "https://docs.example.com/rust-async",
        publishedDate: "2026-02-01T00:00:00.000Z",
        author: "rust team",
        highlights: ["Async is hard", "Use channels"],
        text: "Full page text for content extraction.",
      },
      {
        title: "No Highlights Page",
        url: "https://simple.example.com/page",
        text: "Plain text fallback goes here.",
      },
    ],
  });

  const results = parseJsonResults(json);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Rust Async Patterns");
  assert.equal(results[0]!.snippet, "Async is hard Use channels");
  assert.equal(results[0]!.content, "Full page text for content extraction.");
  assert.equal(results[1]!.url, "https://simple.example.com/page");
  assert.equal(results[1]!.snippet, "Plain text fallback goes here.");
});

test("exa: advanced JSON falls back to formatted parser when not JSON", () => {
  const results = parseJsonResults("Title: X\nURL: https://x.example.com\n");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, "https://x.example.com");
});

test("exa: parses crawl/fetch results and aligns to requested URLs", () => {
  const text = [
    "# Fetch Title One",
    "URL: https://one.example.com",
    "",
    "Content of page one.",
    "",
    "Error fetching https://two.example.com: HTTP 404",
  ].join("\n");

  const results = parseCrawlResults(text, [
    "https://one.example.com",
    "https://two.example.com",
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Fetch Title One");
  assert.equal(results[0]!.content, "Content of page one.");
  assert.equal(results[0]!.error, null);
  assert.equal(results[1]!.url, "https://two.example.com");
  assert.equal(results[1]!.error, "HTTP 404");
});

test("exa: marks missing URLs as errors", () => {
  const results = parseCrawlResults("# Only One\nURL: https://one.example.com\n\nBody", [
    "https://one.example.com",
    "https://missing.example.com",
  ]);
  assert.equal(results[1]!.url, "https://missing.example.com");
  assert.equal(results[1]!.error, "no content returned");
});