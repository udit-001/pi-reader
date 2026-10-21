// crawl-uv.test.ts — exercises the parse seam (crawl-uv's test surface):
// driver stdout in, structured output out. Fixtures are shaped like the real
// driver's output from the live experiment against oraios.github.io/serena.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCrawlDriverOutput } from "../fetch/crawl-uv.ts";

const FIXTURE = JSON.stringify({
  source: "links",
  exhausted: true,
  found: 5,
  pages: [
    { url: "https://oraios.github.io/serena/01-about/000_intro.html", title: "About Serena", text: "# About Serena\n\nThe IDE for Your Coding Agent" },
    { url: "https://oraios.github.io/serena/01-about/020_programming-languages.html", title: "Language Support", text: "Language support page" },
    { url: "https://oraios.github.io/serena/01-about/060_license.html", title: "", text: "", error: "Fetch failed (no response)" },
  ],
});

test("parse: well-formed driver output parses", () => {
  const out = parseCrawlDriverOutput(FIXTURE);
  assert.equal(out.source, "links");
  assert.equal(out.exhausted, true);
  assert.equal(out.found, 5);
  assert.equal(out.pages!.length, 3);
  assert.equal(out.pages![0]!.title, "About Serena");
  assert.equal(out.pages![2]!.error, "Fetch failed (no response)");
});

test("parse: log noise before the JSON is tolerated", () => {
  // trafilatura logs 404s and progress to stderr, but a driver may also
  // print warnings to stdout — the JSON object is the contract.
  const noisy = "WARNING: something\n" + FIXTURE;
  const out = parseCrawlDriverOutput(noisy);
  assert.equal(out.found, 5);
});

test("parse: no JSON at all throws a recoverable error", () => {
  assert.throws(() => parseCrawlDriverOutput("total garbage"), /no JSON/);
});

test("parse: malformed JSON throws a recoverable error", () => {
  assert.throws(() => parseCrawlDriverOutput('{"pages": [oops}'), /unparseable/);
});

test("parse: output without a pages list is rejected", () => {
  assert.throws(() => parseCrawlDriverOutput('{"found": 3}'), /pages list/);
});
