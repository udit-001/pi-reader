// Tests for the videos vertical — `provider: "videos"` backed by the direct
// DDG v.js client (no ddgs — its client is banned from v.js). Pure seams only:
// VQD extraction, request params, the videos normalizer, and the adapter's
// deps flow. Fixtures are trimmed live captures (2026-09-19). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractVqd,
  formatViews,
  buildVideoParams,
  normalizeVideoResults,
  searchVideos,
  type VjsVideoRow,
  type VideosDeps,
} from "../search/videos.ts";
import type { SearchOptions } from "../search/search.ts";

// ── extractVqd — the known-fragile seam, pinned by fixture ────────────────────

// Trimmed live capture of the duckduckgo.com/?q= response (2026-09-19).
const VQD_HTML = `<script>f.fetchPriority="high";window.transport="https://duckduckgo.com/";vqd="4-94267646795443490368238841324734814771";vqdp=[];</script>`;

test("extractVqd pulls the token from the DDG homepage markup", () => {
  assert.equal(extractVqd(VQD_HTML), "4-94267646795443490368238841324734814771");
});

test("extractVqd returns null on a challenge page / markup change — adapter fails loudly, never guesses", () => {
  assert.equal(extractVqd("<html><body>challenge</body></html>"), null);
  assert.equal(extractVqd(""), null);
});

// ── buildVideoParams — the f-grammar and page offset ─────────────────────────

test("video params pin the v.js payload: region, json, moderate safesearch, empty f", () => {
  const p = buildVideoParams("rust tutorial", "4-942", {});
  assert.equal(p.get("l"), "us-en");
  assert.equal(p.get("o"), "json");
  assert.equal(p.get("q"), "rust tutorial");
  assert.equal(p.get("vqd"), "4-942");
  assert.equal(p.get("p"), "-1");
  assert.equal(p.get("f"), ",,,");
  assert.equal(p.get("s"), null); // page 1 sends no offset
});

test("video params map recency into the publishedAfter slot of f", () => {
  for (const [recency, code] of [["day", "d"], ["week", "w"], ["month", "m"], ["year", "y"]] as const) {
    const p = buildVideoParams("q", "4-942", { recency });
    assert.equal(p.get("f"), `publishedAfter:${code},,,`);
  }
});

test("video params offset page N by 60 per page (page 3 → s=120)", () => {
  const p = buildVideoParams("q", "4-942", { page: 3 });
  assert.equal(p.get("s"), "120");
});

// ── formatViews — compact counts ───────────────────────────────────────────────

test("formatViews compacts large counts and tolerates junk", () => {
  assert.equal(formatViews(1216317), "1.2M");
  assert.equal(formatViews(592793), "592.8k");
  assert.equal(formatViews(41), "41");
  assert.equal(formatViews(undefined), null);
  assert.equal(formatViews(-5), null);
});

// ── normalizeVideoResults — agent-POV normalization ────────────────────────────

// Trimmed live capture of a v.js results row (2026-09-19).
const RICH_ROW: VjsVideoRow = {
  title: "Learn Rust Programming - Complete Course 🦀",
  content: "https://www.youtube.com/watch?v=BpPEoZW5IiY",
  description: "In this comprehensive Rust course for beginners…",
  duration: "13:59:10",
  embed_html: "<iframe width=\"1280\" height=\"720\"…",
  embed_url: "https://www.youtube.com/embed/BpPEoZW5IiY?autoplay=1",
  image_token: "302b1e1f…",
  images: { large: "https://tse2.mm.bing.net/th/id/OVP.x" },
  provider: "Bing",
  publisher: "YouTube",
  published: "2023-06-08T12:43:32.0000000",
  statistics: { viewCount: 1216317 },
  uploader: "freeCodeCamp.org",
  thumbnail_height: 360,
  thumbnail_width: 480,
};

test("videos normalizer maps content→url, uploader→author, duration+views+via into snippet", () => {
  const [r] = normalizeVideoResults([RICH_ROW]);
  assert.deepEqual(
    { title: r!.title, url: r!.url, snippet: r!.snippet, author: r!.author, publishedDate: r!.publishedDate },
    {
      title: "Learn Rust Programming - Complete Course 🦀",
      url: "https://www.youtube.com/watch?v=BpPEoZW5IiY",
      snippet: "13:59:10 · 1.2M views · via freeCodeCamp.org",
      author: "freeCodeCamp.org",
      publishedDate: "2023-06-08T12:43:32.0000000",
    },
  );
});

test("videos normalizer tolerates missing uploader, views, and duration — no invented tokens", () => {
  const [r] = normalizeVideoResults([{ title: "t", content: "https://e.com/v" }]);
  assert.equal(r!.snippet, "");
  assert.equal("author" in r, false);
});

test("videos normalizer falls back to publisher for the via-token when uploader is missing", () => {
  const [r] = normalizeVideoResults([{ title: "t", content: "https://e.com/v", publisher: "Vimeo" }]);
  assert.equal(r!.snippet, "via Vimeo");
  assert.equal(r!.author, "Vimeo");
});

test("videos normalizer drops rows without a watch url — no url, no action", () => {
  const results = normalizeVideoResults([
    { title: "no url" },
    { title: "has url", content: "https://e.com/v" },
  ]);
  assert.deepEqual(results.map((r) => r.title), ["has url"]);
});

test("videos normalizer returns an empty array for empty input", () => {
  assert.deepEqual(normalizeVideoResults([]), []);
});

// ── searchVideos — deps flow, numResults slice, error shaping ──────────────────

function depsWith(overrides: Partial<VideosDeps>): VideosDeps {
  return {
    fetchVqd: async () => "4-942",
    fetchVideoRows: async () => [RICH_ROW],
    ...overrides,
  };
}

test("searchVideos returns normalized video results on the happy path", async () => {
  const [r] = await searchVideos("rust tutorial", {}, depsWith({}));
  assert.equal(r!.url, "https://www.youtube.com/watch?v=BpPEoZW5IiY");
  assert.equal(r!.snippet, "13:59:10 · 1.2M views · via freeCodeCamp.org");
});

test("searchVideos passes query and params (recency, page, signal) through unchanged", async () => {
  const seen: Array<{ q: string; vqd: string; o: SearchOptions }> = [];
  const signal = new AbortController().signal;
  const options: SearchOptions = { recency: "week", page: 2, signal };
  await searchVideos("rust", options, depsWith({
    fetchVideoRows: async (q, vqd, o) => {
      seen.push({ q, vqd, o });
      return [RICH_ROW];
    },
  }));
  assert.equal(seen[0]!.q, "rust");
  assert.equal(seen[0]!.vqd, "4-942");
  assert.equal(seen[0]!.o.recency, "week");
  assert.equal(seen[0]!.o.page, 2);
  assert.equal(seen[0]!.o.signal, signal);
});

test("searchVideos slices results to numResults", async () => {
  const rows = [RICH_ROW, RICH_ROW, RICH_ROW];
  const results = await searchVideos("q", { numResults: 2 }, depsWith({ fetchVideoRows: async () => rows }));
  assert.equal(results.length, 2);
});

test("searchVideos throws with the workaround named when the VQD token is missing", async () => {
  await assert.rejects(
    searchVideos("q", {}, depsWith({ fetchVqd: async () => null })),
    /domains: \["youtube\.com"\]/,
  );
});

test("searchVideos wraps fetchVideoRows failures — cause visible, workaround named", async () => {
  await assert.rejects(
    searchVideos("q", {}, depsWith({ fetchVideoRows: async () => { throw new Error("DuckDuckGo returned 403"); } })),
    /403.*domains: \["youtube\.com"\]/s,
  );
});

test("searchVideos throws on zero parseable results — no fake success", async () => {
  await assert.rejects(
    searchVideos("q", {}, depsWith({ fetchVideoRows: async () => [] })),
    /no parseable results/,
  );
});
