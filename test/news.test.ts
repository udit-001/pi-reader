// Tests for the news vertical — `provider: "news"` backed by the ddgs news
// subcommand. Pure seams only: the news normalizer, the news argv plan, the
// degrade-to-text flow with injected deps. No network, no processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDdgsArgs } from "../search/ddgs-uv.ts";
import {
  normalizeNewsResults,
  withNewsNotice,
  searchNews,
  type DdgsNewsRow,
  type NewsDeps,
} from "../search/news.ts";
import type { SearchOptions, SearchResult } from "../search/search.ts";

// ── normalizeNewsResults — verbatim normalization, invents nothing ──────────

test("news normalizer maps clean ISO date verbatim to publishedDate", () => {
  const [r] = normalizeNewsResults([{
    date: "2026-09-10T12:22:21+00:00",
    title: "Kernel released",
    body: "The kernel shipped today.",
    url: "https://example.com/a",
    source: "Phoronix",
    image: "https://img.example.com/x",
  }]);
  assert.equal(r!.publishedDate, "2026-09-10T12:22:21+00:00");
});

test("news normalizer passes source junk dates through unmodified", () => {
  const [r] = normalizeNewsResults([{ date: "Opinion2 days ago", title: "t", url: "https://e.com" }]);
  assert.equal(r!.publishedDate, "Opinion2 days ago");
});

test("news normalizer maps body→snippet, source→author, keeps title/url, drops image", () => {
  const [r] = normalizeNewsResults([{
    date: "2026-09-10T12:22:21+00:00",
    title: "Headline",
    body: "Body text",
    url: "https://example.com/a",
    source: "BetaNews",
    image: "https://www.bing.com/th?id=ONUT.x",
  }]);
  assert.deepEqual(
    { title: r!.title, url: r!.url, snippet: r!.snippet, author: r!.author },
    { title: "Headline", url: "https://example.com/a", snippet: "Body text", author: "BetaNews" },
  );
  assert.equal("image" in r, false);
});

test("news normalizer handles missing fields without inventing values", () => {
  const [r] = normalizeNewsResults([{ title: "Only a title", url: "https://example.com/a" }]);
  assert.equal(r!.title, "Only a title");
  assert.equal(r!.url, "https://example.com/a");
  assert.equal(r!.snippet, "");
  assert.equal(r!.publishedDate, undefined);
  assert.equal(r!.author, undefined);
});

test("news normalizer drops rows without a url", () => {
  const rows: DdgsNewsRow[] = [
    { title: "no url" },
    { title: "has url", url: "https://example.com/a" },
  ];
  const results = normalizeNewsResults(rows);
  assert.deepEqual(results.map((r) => r.title), ["has url"]);
});

test("news normalizer returns an empty array for empty input", () => {
  assert.deepEqual(normalizeNewsResults([]), []);
});

// ── buildDdgsArgs — the argv plan generalizes to a subcommand param ─────────

const NEWS_ARGS = {
  subcommand: "news" as const,
  query: "linux kernel",
  maxResults: 5,
  uvx: "/usr/bin/uvx",
  output: "/tmp/out.json",
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("buildDdgsArgs runs the news subcommand with the same flag set as text", () => {
  const args = buildDdgsArgs(NEWS_ARGS);
  assert.deepEqual(args.slice(0, 3), ["/usr/bin/uvx", "ddgs", "news"]);
  assert.equal(flagValue(args, "-q"), "linux kernel");
  assert.equal(flagValue(args, "-m"), "5");
  assert.equal(flagValue(args, "-o"), "/tmp/out.json");
  assert.ok(!args.includes("-t"));
  assert.ok(!args.includes("-p"));
});

test("buildDdgsArgs binds timelimit and page on the news path", () => {
  const args = buildDdgsArgs({ ...NEWS_ARGS, timelimit: "w", page: 2 });
  assert.equal(flagValue(args, "-t"), "w");
  assert.equal(flagValue(args, "-p"), "2");
});

test("buildDdgsArgs keeps the news query as ONE argv slot", () => {
  const hostile = 'x"; $(touch /tmp/PI_AUDIT_POC); `id`; \\';
  const args = buildDdgsArgs({ ...NEWS_ARGS, query: hostile });
  assert.deepEqual([flagValue(args, "-q")], [hostile]);
});

// ── withNewsNotice — degrade must be visible ─────────────────────────────────

test("withNewsNotice appends a visible notice to the last result", () => {
  const results: SearchResult[] = [
    { title: "a", url: "https://a.com", snippet: "first" },
    { title: "b", url: "https://b.com", snippet: "last" },
  ];
  const noted = withNewsNotice(results, "no-uv");
  assert.equal(noted[0]!.snippet, "first");
  assert.match(noted[1]!.snippet, /News:/);
  assert.match(noted[1]!.snippet, /text search/);
});

test("withNewsNotice distinguishes no-uv from ddgs-failed", () => {
  const results: SearchResult[] = [{ title: "a", url: "https://a.com", snippet: "s" }];
  assert.match(withNewsNotice(results, "no-uv")[0]!.snippet, /uvx unavailable/);
  assert.match(withNewsNotice(results, "ddgs-failed")[0]!.snippet, /ddgs news failed/);
});

test("withNewsNotice leaves empty results empty", () => {
  assert.deepEqual(withNewsNotice([], "no-uv"), []);
});

// ── searchNews — degrade-to-text flow at the adapter seam ────────────────────

const textResults: SearchResult[] = [{ title: "text hit", url: "https://t.com", snippet: "webpage" }];

function depsWith(overrides: Partial<NewsDeps>): NewsDeps {
  return {
    hasUvx: () => true,
    runNews: () => [{ title: "news hit", url: "https://n.com", snippet: "article", publishedDate: "2026-09-10", author: "Phoronix" }],
    runText: async () => textResults,
    ...overrides,
  };
}

test("searchNews returns normalized news results on the happy path", async () => {
  const raw: DdgsNewsRow[] = [{ date: "2026-09-10", title: "t", body: "b", url: "https://n.com", source: "Phoronix" }];
  const outcome = await searchNews("q", {}, depsWith({ runNews: () => normalizeNewsResults(raw) }));
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.results[0]!.author, "Phoronix");
});

test("searchNews degrades to text when uvx is missing, with a visible notice", async () => {
  const outcome = await searchNews("q", {}, depsWith({ hasUvx: () => false }));
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.reason, "no-uv");
  assert.equal(outcome.results[0]!.title, "text hit");
  assert.match(outcome.results[0]!.snippet, /News:/);
});

test("searchNews degrades to text when the ddgs news call fails", async () => {
  const outcome = await searchNews("q", {}, depsWith({ runNews: () => { throw new Error("boom"); } }));
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.reason, "ddgs-failed");
  assert.match(outcome.results[0]!.snippet, /News:/);
});

test("searchNews passes the same query and window to the text leg", async () => {
  const seen: Array<{ q: string; o: SearchOptions }> = [];
  const outcome = await searchNews(
    "linux",
    { recency: "week", page: 2 },
    depsWith({ hasUvx: () => false, runText: async (q, o) => { seen.push({ q, o }); return textResults; } }),
  );
  assert.equal(outcome.degraded, true);
  assert.equal(seen[0]!.q, "linux");
  assert.equal(seen[0]!.o.recency, "week");
  assert.equal(seen[0]!.o.page, 2);
});

test("searchNews rethrows when both legs fail — actionable error, no fake results", async () => {
  await assert.rejects(
    searchNews("q", {}, depsWith({ runNews: () => { throw new Error("boom"); }, runText: async () => { throw new Error("captcha"); } })),
    /captcha/,
  );
});
