// crawl.test.ts — exercises the policy seam (crawl.ts's pure surface): the
// budget contract, capped-vs-complete, link scoping, and excerpts. The uv
// driver and the fetch chain behind the adapters are not unit-tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXCERPT_CHARS,
  candidateLinks,
  excerptOf,
  isCrawlableUrl,
  shapeCrawl,
} from "../fetch/crawl.ts";

const SEED = "https://docs.example.com/guide/";

test("isCrawlableUrl: http(s) only", () => {
  assert.equal(isCrawlableUrl("https://example.com/a"), true);
  assert.equal(isCrawlableUrl("http://example.com/"), true);
  assert.equal(isCrawlableUrl("ftp://example.com/"), false);
  assert.equal(isCrawlableUrl("not a url"), false);
});

test("candidateLinks: same-origin only, deduped, capped, order kept", () => {
  const html = [
    '<a href="/guide/intro.html">intro</a>',
    '<a href="https://docs.example.com/guide/api.html">api</a>',
    '<a href="https://docs.example.com/guide/intro.html">repeat</a>',
    '<a href="https://elsewhere.com/page">other host</a>',
    '<a href="#section">fragment</a>',
  ].join("");
  const links = candidateLinks(html, SEED, 10);
  assert.deepEqual(links, [
    "https://docs.example.com/guide/intro.html",
    "https://docs.example.com/guide/api.html",
  ]);
  assert.equal(candidateLinks(html, SEED, 1).length, 1);
});

test("candidateLinks: query-normalized extension filter — assets with ?digest= drop", () => {
  // The experiment's lesson: docs sites suffix assets with a query string.
  const html = [
    '<link href="/static/theme.css?digest=abc">',
    '<script src="/static/app.js?v=2"></script>',
    '<a href="https://docs.example.com/guide/page.html">page</a>',
  ].join("");
  assert.deepEqual(candidateLinks(html, SEED, 10), [
    "https://docs.example.com/guide/page.html",
  ]);
});

test("excerptOf: flattened, cut at the budget with a marker", () => {
  assert.equal(excerptOf("  lots   of\nspace  "), "lots of space");
  const long = Array.from({ length: 200 }, () => "word").join(" ");
  const cut = excerptOf(long);
  assert.ok(cut.length <= EXCERPT_CHARS);
  assert.ok(cut.endsWith("…"));
  assert.equal(excerptOf("short"), "short");
});

test("shapeCrawl: not exhausted → capped, found carries the total", () => {
  const out = {
    source: "sitemap" as const,
    exhausted: false,
    found: 17,
    pages: [
      { url: "https://docs.example.com/guide/a.html", title: "A", text: "text a" },
      { url: "https://docs.example.com/guide/b.html", title: "", text: "", error: "Fetch failed" },
    ],
  };
  const r = shapeCrawl(out, 8);
  assert.equal(r.source, "sitemap");
  assert.equal(r.capped, true);
  assert.equal(r.found, 17);
  assert.equal(r.pages.length, 2);
  assert.equal(r.pages[0]!.error, null);
  assert.equal(r.pages[1]!.error, "Fetch failed");
});

test("shapeCrawl: drained frontier → complete", () => {
  const r = shapeCrawl({ source: "links", exhausted: true, found: 3, pages: [] }, 8);
  assert.equal(r.capped, false);
  assert.equal(r.found, 3);
});

test("shapeCrawl: missing fields default — an old driver still shapes", () => {
  const r = shapeCrawl({ pages: [{ url: "https://x.example.com/" }] }, 8);
  assert.equal(r.source, "links");
  assert.equal(r.capped, false);
  assert.equal(r.found, 1);
  assert.equal(r.pages[0]!.title, "");
  assert.equal(r.pages[0]!.content, "");
  assert.equal(r.pages[0]!.error, null);
});
