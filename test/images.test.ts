// Tests for the images vertical — `provider: "images"` backed by the ddgs
// images subcommand. Pure seams only: the images normalizer and the adapter's
// deps flow (query/params pass-through). No network, no processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeImageResults, searchImages, type DdgsImageRow, type ImagesDeps } from "../search/images.ts";
import type { SearchOptions } from "../search/search.ts";

// ── normalizeImageResults — agent-POV normalization ──────────────────────────

test("images normalizer maps image→url, title verbatim, dims+source into snippet", () => {
  const [r] = normalizeImageResults([{
    title: "Sunflower Field Sunset Wallpapers",
    image: "https://wallpaperaccess.com/full/3608492.jpg",
    url: "https://wallpaperaccess.com/sunflower-field-sunset",
    thumbnail: "https://ts4.mm.bing.net/th?id=OIP.x",
    width: "2048",
    height: "1365",
    source: "wallpaperaccess.com",
  }]);
  assert.deepEqual(
    { title: r!.title, url: r!.url, snippet: r!.snippet },
    {
      title: "Sunflower Field Sunset Wallpapers",
      url: "https://wallpaperaccess.com/full/3608492.jpg",
      snippet: "2048×1365 · via wallpaperaccess.com",
    },
  );
  // Dropped: the source page and the thumbnail are no-ops for the agent.
  assert.equal("author" in r, false);
  assert.equal("publishedDate" in r, false);
});

test("images normalizer tolerates missing dims and source", () => {
  const [r] = normalizeImageResults([{ title: "t", image: "https://e.com/i.jpg" }]);
  assert.equal(r!.snippet, "");
});

test("images normalizer keeps a lone dims token (no source) and a lone source token (no dims)", () => {
  const [dimsOnly] = normalizeImageResults([{ title: "a", image: "https://e.com/a.jpg", width: "640", height: "480" }]);
  assert.equal(dimsOnly!.snippet, "640×480");
  const [srcOnly] = normalizeImageResults([{ title: "b", image: "https://e.com/b.jpg", source: "e.com" }]);
  assert.equal(srcOnly!.snippet, "via e.com");
});

test("images normalizer ignores non-numeric dims instead of inventing a token", () => {
  const [r] = normalizeImageResults([{ title: "t", image: "https://e.com/i.jpg", width: "large", height: "", source: "e.com" }]);
  assert.equal(r!.snippet, "via e.com");
});

test("images normalizer treats an empty-string dim as missing, never 0", () => {
  const [r] = normalizeImageResults([{ title: "t", image: "https://e.com/i.jpg", width: "640", height: "", source: "e.com" }]);
  assert.equal(r!.snippet, "via e.com");
});

test("images normalizer drops rows without an image url — no url, no action", () => {
  const rows: DdgsImageRow[] = [
    { title: "no image" },
    { title: "has image", image: "https://e.com/i.jpg" },
  ];
  const results = normalizeImageResults(rows);
  assert.deepEqual(results.map((r) => r.title), ["has image"]);
});

test("images normalizer returns an empty array for empty input", () => {
  assert.deepEqual(normalizeImageResults([]), []);
});

// ── searchImages — params pass through to the run seam ───────────────────────

function depsWith(overrides: Partial<ImagesDeps>): ImagesDeps {
  return {
    hasUvx: () => true,
    runImages: () => normalizeImageResults([{ title: "img hit", image: "https://e.com/i.jpg", width: "640", height: "480", source: "e.com" }]),
    ...overrides,
  };
}

test("searchImages returns normalized image results on the happy path", async () => {
  const outcome = await searchImages("sunflower field", {}, depsWith({}));
  assert.equal(outcome[0]!.url, "https://e.com/i.jpg");
  assert.equal(outcome[0]!.snippet, "640×480 · via e.com");
});

test("searchImages passes query and params (recency, page, license) through unchanged", async () => {
  const seen: Array<{ q: string; o: SearchOptions }> = [];
  const options: SearchOptions = { recency: "month", page: 3, license: "commercial" };
  await searchImages("sunflower", options, depsWith({
    runImages: (q, o) => { seen.push({ q, o }); return []; },
  }));
  assert.equal(seen[0]!.q, "sunflower");
  assert.equal(seen[0]!.o.recency, "month");
  assert.equal(seen[0]!.o.page, 3);
  assert.equal(seen[0]!.o.license, "commercial");
});

test("searchImages throws when uvx is missing — images have no text substitute", async () => {
  await assert.rejects(
    searchImages("q", {}, depsWith({ hasUvx: () => false })),
    /uvx/,
  );
});

test("searchImages rethrows ddgs failures — actionable error, no fake results", async () => {
  await assert.rejects(
    searchImages("q", {}, depsWith({ runImages: () => { throw new Error("ddgs boom"); } })),
    /ddgs boom/,
  );
});
