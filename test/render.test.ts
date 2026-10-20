// render.test.ts — exercises the pure view seam (searchView), the module's
// test surface. Theme and TUI assembly sit behind it and are verified by
// typecheck plus a visual pass, not pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSED_ROWS,
  PEOPLE_WRAP_COLS,
  SNIPPET_CHARS,
  peopleView,
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

// ── People view ──────────────────────────────────────────────────────────────
// Tests cross the same seam callers do: peopleView. The renderer callbacks
// (theme colors, Text assembly) stay behind it, verified visually.

function peopleRow(snippet: string, title = "Addy Osmani"): WebSearchDetailsRow {
  return {
    title,
    url: "https://www.linkedin.com/in/addyosmani",
    snippet,
    publishedDate: "2026-10-14T20:54:20.000Z",
  };
}

const LINKEDIN_SNIPPET =
  "# Addy Osmani Member of Technical Staff at Anthropic San Francisco Bay Area (US) " +
  "500 connections • 305,360 followers ## About Addy Osmani is an Irish Software " +
  "Engineer and leader who was most recently a director at Googl";

function expandedPeople(results: WebSearchDetailsRow[], now = Date.parse("2026-10-15T20:54:20.000Z")) {
  return peopleView(
    { provider: "exa", resultCount: results.length, category: "people", results },
    { expanded: true, query: "q", now },
  );
}

test("people: markers stripped, name prefix removed, full text kept, upstream cut marked", () => {
  const view = expandedPeople([peopleRow(LINKEDIN_SNIPPET)]);
  const r = view.rows[0]!;
  const profile = r.profile!.map((l) => l.slice(3)).join(" ");
  assert.equal(r.name, "Addy Osmani");
  assert.equal(
    profile,
    "Member of Technical Staff at Anthropic San Francisco Bay Area (US) " +
      "500 connections • 305,360 followers About Addy Osmani is an Irish Software " +
      "Engineer and leader who was most recently a director at Googl…",
  );
  assert.equal(r.url, "https://www.linkedin.com/in/addyosmani");
  assert.equal(r.publishedDate, "1d ago");
});

test("people: heading markers mid-text stripped, word-internal # preserved", () => {
  const view = expandedPeople([peopleRow(
    "# Michael Vandi CEO @ Addy AI ## ex-AWS Software Engineer ## C# and backend " +
    "### mortgage agents platform",
    "Michael Vandi",
  )]);
  const profile = view.rows[0]!.profile!.map((l) => l.slice(3)).join(" ");
  assert.equal(profile, "CEO @ Addy AI ex-AWS Software Engineer C# and backend mortgage agents platform…");
});

test("people: text ending in punctuation is not marked as cut", () => {
  const view = expandedPeople([peopleRow(
    "# Jane Doe Founder at Example Corp Austin, Texas (US) builds things.", "Jane Doe")]);
  const profile = view.rows[0]!.profile!.map((l) => l.slice(3)).join(" ");
  assert.ok(profile.endsWith("builds things."));
  assert.ok(!profile.endsWith("…"));
});

test("people: a row with no snippet shows only the name and url", () => {
  const view = expandedPeople([peopleRow("")]);
  const r = view.rows[0]!;
  assert.equal(r.name, "Addy Osmani");
  assert.equal(r.profile, undefined);
});

test("people: profile text keeps a hanging indent inside the wrap width", () => {
  const long = "word ".repeat(60) + "end.";
  const view = expandedPeople([peopleRow("# A B Role Somewhere (US) " + long)]);
  const lines = view.rows[0]!.profile!;
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.startsWith("   ")));
  assert.ok(lines.every((l) => l.length <= PEOPLE_WRAP_COLS + 3));
  assert.ok(lines.join(" ").includes("end."));
});

test("people: collapsed shows one-liner rows — profile withheld, remainder counted", () => {
  const results = Array.from({ length: 10 }, (_, i) => peopleRow(LINKEDIN_SNIPPET, `Person ${i}`));
  const view = peopleView(
    { provider: "exa", resultCount: 10, category: "people", results },
    { expanded: false, query: "q", now: Date.parse("2026-10-15T00:00:00.000Z") },
  );
  assert.equal(view.rows.length, COLLAPSED_ROWS);
  assert.equal(view.hiddenCount, 10 - COLLAPSED_ROWS);
  assert.ok(view.rows.every((r) => r.profile === undefined));
  assert.ok(view.rows.every((r) => r.name && r.url && r.publishedDate));
});

test("people: expanded reveals every row with its full profile text", () => {
  const results = Array.from({ length: 10 }, (_, i) => peopleRow(LINKEDIN_SNIPPET, `Person ${i}`));
  const view = expandedPeople(results);
  assert.equal(view.rows.length, 10);
  assert.equal(view.hiddenCount, 0);
  assert.ok(view.rows.every((r) => r.profile !== undefined));
});

test("people: older timestamps render as a short date, bad ones as undefined", () => {
  const results = [peopleRow(LINKEDIN_SNIPPET), peopleRow(LINKEDIN_SNIPPET, "X Y")];
  results[1]!.publishedDate = "not-a-date";
  const view = expandedPeople(results, Date.parse("2027-02-15T00:00:00.000Z"));
  assert.equal(view.rows[0]!.publishedDate, "Oct 14, 2026");
  assert.equal(view.rows[1]!.publishedDate, undefined);
});
