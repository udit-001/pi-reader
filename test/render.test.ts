// render.test.ts — exercises the pure view seam (searchView), the module's
// test surface. Theme and TUI assembly sit behind it and are verified by
// typecheck plus a visual pass, not pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSED_ROWS,
  SNIPPET_CHARS,
  searchView,
  type WebSearchDetails,
  type WebSearchDetailsRow,
} from "../render.ts";

function row(i: number): WebSearchDetailsRow {
  return {
    title: `Title ${i}`,
    url: `https://example.com/${i}`,
    snippet: `Snippet ${i}`,
    publishedDate: `2026-10-0${i}`,
  };
}

function details(n: number, extra: Partial<WebSearchDetails> = {}): WebSearchDetails {
  return {
    provider: "duckduckgo",
    resultCount: n,
    results: Array.from({ length: n }, (_, i) => row(i + 1)),
    ...extra,
  };
}

test("collapsed: caps rows at COLLAPSED_ROWS, counts the hidden remainder, no snippets", () => {
  const view = searchView(details(15), { expanded: false, query: "q" });
  assert.equal(view.rows.length, COLLAPSED_ROWS);
  assert.equal(view.hiddenCount, 15 - COLLAPSED_ROWS);
  assert.equal(view.count, 15);
  assert.ok(view.rows.every((r) => r.snippet === undefined));
});

test("collapsed: a short page hides nothing", () => {
  const view = searchView(details(2), { expanded: false, query: "q" });
  assert.equal(view.rows.length, 2);
  assert.equal(view.hiddenCount, 0);
});

test("expanded: every row carries a whitespace-normalized snippet", () => {
  const d = details(15);
  d.results![0]!.snippet = "  lots   of\nspace  ";
  const view = searchView(d, { expanded: true, query: "q" });
  assert.equal(view.rows.length, 15);
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.rows[0]!.snippet, "lots of space");
});

test("expanded: snippets are capped at SNIPPET_CHARS", () => {
  const d = details(1);
  d.results![0]!.snippet = "x".repeat(SNIPPET_CHARS * 2);
  const view = searchView(d, { expanded: true, query: "q" });
  assert.equal(view.rows[0]!.snippet!.length, SNIPPET_CHARS);
});

test("count falls back to row count when the provider reported no total", () => {
  const d = details(3);
  delete d.resultCount;
  assert.equal(searchView(d, { expanded: false, query: "q" }).count, 3);
});

test("missing title renders as (untitled)", () => {
  const d = details(1);
  d.results![0]!.title = "";
  assert.equal(searchView(d, { expanded: true, query: "q" }).rows[0]!.title, "(untitled)");
});

test("error and nextCursor ride the view through", () => {
  const view = searchView(
    { error: "Search failed.", resultCount: 0, results: [] },
    { expanded: false, query: "q" },
  );
  assert.equal(view.error, "Search failed.");
  const withCursor = searchView(details(2, { nextCursor: "abc" }), {
    expanded: false,
    query: "q",
  });
  assert.equal(withCursor.nextCursor, "abc");
});

test("undefined details produce an empty view, not a throw", () => {
  const view = searchView(undefined, { expanded: false, query: "q" });
  assert.equal(view.count, 0);
  assert.equal(view.rows.length, 0);
  assert.equal(view.hiddenCount, 0);
});

test("paper rows ride the web-row layout without a second branch", () => {
  // Papers details carry ~30 extra fields; the view must ignore them all.
  const paperRow = { ...row(1), fwci: 2.4, refs: ["W1"], citedBy: 99 };
  const view = searchView(
    { provider: "papers", resultCount: 1, results: [paperRow] },
    { expanded: true, query: "q" },
  );
  assert.deepEqual(view.rows[0], {
    index: 1,
    title: "Title 1",
    url: "https://example.com/1",
    publishedDate: "2026-10-01",
    snippet: "Snippet 1",
  });
});
