// crawl-stream.test.ts — pins the NDJSON line-protocol decisions from
// docs/specs/crawl-streaming.md: one line per page, garbage skips, partial
// recovery when the driver dies before its summary, milestone throttle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCrawlDriverLine, runCrawlDriver, type DriverOutput, type DriverPage } from "../fetch/crawl-uv.ts";
import { crawlMilestoneNote } from "../fetch/crawl.ts";

// ── parseCrawlDriverLine — the pure protocol seam ─────────────────────────────

test("line: page event parses", () => {
  const line = JSON.stringify({ page: { url: "https://a.test/", text: "x", error: null } });
  const parsed = parseCrawlDriverLine(line);
  assert.equal(parsed.kind, "page");
  assert.ok(parsed.kind === "page" && parsed.page.url === "https://a.test/");
});

test("line: summary parses", () => {
  const line = JSON.stringify({ source: "links", exhausted: true, found: 3, pages: [] });
  const parsed = parseCrawlDriverLine(line);
  assert.equal(parsed.kind, "summary");
  assert.ok(parsed.kind === "summary" && parsed.out.found === 3);
});

test("line: garbage skips — warnings and tracebacks never kill the parse", () => {
  for (const bad of [
    "",
    "   ",
    "Downloading wheels…",
    "hello {not json",
    '{"broken": [',
    '{"page": "not-an-object"}', // page present but not an object — no shape match
    '{"source": "links"}',       // summary claimed without pages array — skip
    "null",
  ]) {
    assert.equal(parseCrawlDriverLine(bad).kind, "skip", `line: ${bad}`);
  }
});

test("line: page with extra keys stays a page (tolerant protocol)", () => {
  const line = JSON.stringify({ page: { url: "https://a.test/" }, extra: 1 });
  assert.equal(parseCrawlDriverLine(line).kind, "page");
});

// ── runCrawlDriver — outcome ladder (child as dependency injection) ──────────

const samplePage = (u: string): DriverPage => ({ url: u, title: "", text: "t", error: null });
const validate = <T extends DriverOutput>(o: T): T => o;
const spawn = (summary: DriverOutput | null, pages: DriverPage[]) =>
  async () => ({ summary, pages });

test("ladder: summary present wins", async () => {
  const summary: DriverOutput = {
    source: "links", exhausted: true, found: 2,
    pages: [samplePage("https://a/"), samplePage("https://b/")],
  };
  const out = await runCrawlDriver([], spawn(summary, []), undefined, validate);
  assert.equal(out.found, 2);
});

test("ladder: driver died before summary, pages survive (partial recovery)", async () => {
  const pages = [samplePage("https://a/"), samplePage("https://b/"), samplePage("https://c/")];
  const out = await runCrawlDriver([], spawn(null, pages), undefined, validate);
  assert.equal(out.found, 3);
  assert.equal(out.exhausted, false); // synthesized: capped, never overstated
  assert.equal(out.pages, pages);
});

test("ladder: driver died with nothing — throws (behavior unchanged)", async () => {
  await assert.rejects(
    runCrawlDriver([], spawn(null, []), undefined, validate),
    /no JSON/,
  );
});

// ── crawlMilestoneNote — pixels earned, not spammed ─────────────────────────

test("milestones: fire at 5, then every 5, never repeat", () => {
  const notedCounts: number[] = [];
  let noted = 0;
  for (let seen = 1; seen <= 12; seen++) {
    const note = crawlMilestoneNote(seen, noted);
    if (note) {
      noted = seen;
      notedCounts.push(seen);
    }
  }
  assert.deepEqual(notedCounts, [5, 10]);
  // Text: one line, counts only, no page content.
  assert.equal(crawlMilestoneNote(5, 0), "Crawled 5 pages…");
});

test("milestones: quiet crawl (4 pages) stays silent", () => {
  let noted = 0;
  const notes = [1, 2, 3, 4].map((seen) => crawlMilestoneNote(seen, noted)).filter(Boolean);
  assert.deepEqual(notes, []);
});
