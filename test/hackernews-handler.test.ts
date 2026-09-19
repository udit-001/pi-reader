// Tests for the Hacker News handler's pure seams: listingQuery (which
// news.ycombinator.com listing paths are served, and the Algolia query behind
// each) and formatStories. The HTTP layer stays behind the handler interface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listingQuery, formatStories } from "../fetch/handlers/hackernews.ts";

test("listingQuery maps every served listing path to its Algolia query", () => {
  assert.deepEqual(listingQuery("/"), { endpoint: "search", tags: "front_page", label: "front page" });
  assert.deepEqual(listingQuery("/news"), { endpoint: "search", tags: "front_page", label: "front page" });
  assert.deepEqual(listingQuery("/newest"), { endpoint: "search_by_date", tags: "story", label: "newest stories" });
  assert.deepEqual(listingQuery("/show"), { endpoint: "search_by_date", tags: "show_hn", label: "Show HN" });
  assert.deepEqual(listingQuery("/ask"), { endpoint: "search_by_date", tags: "ask_hn", label: "Ask HN" });
  assert.deepEqual(listingQuery("/jobs"), { endpoint: "search_by_date", tags: "job", label: "jobs" });
  // trailing slash normalizes to the same listing
  assert.deepEqual(listingQuery("/show/"), { endpoint: "search_by_date", tags: "show_hn", label: "Show HN" });
});

test("listingQuery leaves other paths to the plain-page fetch", () => {
  assert.equal(listingQuery("/item"), undefined);
  assert.equal(listingQuery("/from"), undefined);
  assert.equal(listingQuery("/user?id=someone"), undefined);
});

test("formatStories renders numbered stories with link, points, and comments", () => {
  const out = formatStories([
    {
      objectID: "49757757",
      title: "Show HN: My side project",
      url: "https://example.com",
      points: 120,
      author: "ada",
      num_comments: 34,
      created_at: "2026-09-19T10:00:00Z",
    },
    {
      objectID: "49744416",
      title: null,
      url: null,
      points: null,
      author: null,
      num_comments: null,
      created_at: null,
    },
  ]);
  assert.match(out, /^1\. Show HN: My side project$/m);
  assert.match(out, /^   https:\/\/example\.com$/m);
  assert.match(out, /120 points \| 34 comments \| by ada \| 2026-09-19/);
  // text-only post: falls back to the HN item link, zeroed facts
  assert.match(out, /^2\. \(untitled\)$/m);
  assert.match(out, /https:\/\/news\.ycombinator\.com\/item\?id=49744416/);
  assert.match(out, /0 points \| 0 comments$/m);
});

test("formatStories handles the empty list", () => {
  assert.equal(formatStories([]), "No stories found.");
});
