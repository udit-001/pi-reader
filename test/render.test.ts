// render.test.ts — exercises the pure view seam (searchView), the module's
// test surface. Theme and TUI assembly sit behind it and are verified by
// typecheck plus a visual pass, not pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import {
  COLLAPSED_ROWS,
  FETCH_PREVIEW_CHARS,
  PROSE_PREVIEW_CHARS,
  PROSE_WRAP_COLS,
  SNIPPET_CHARS,
  fetchView,
  formatChars,
  papersView,
  peopleView,
  searchView,
  type FetchDetails,
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
  assert.equal(stripTerminalSequences(view.rows[0]!.snippet!).length, SNIPPET_CHARS);
  assert.ok(stripTerminalSequences(view.rows[0]!.snippet!).endsWith("…"));
});

test("expanded: snippet markdown markers are stripped", () => {
  const d = details(1);
  d.results![0]!.snippet = "t only **1.1×** on server-side rendering — see `docs`";
  const view = searchView(d, { expanded: true, query: "q" });
  assert.equal(view.rows[0]!.snippet, "t only 1.1× on server-side rendering — see docs");
});

test("count falls back to row count when the provider reported no total", () => {
  const d = details(3);
  delete d.resultCount;
  assert.equal(searchView(d, { expanded: false, query: "q" }).count, 3);
});

/** The answer block is pre-wrapped lines with a 3-space hanging indent;
 *  unwrap for whole-string assertions. */
function unwrap(lines: string[]): string {
  return lines.map((l) => l.slice(3)).join(" ");
}

test("answer: collapsed carries a preview cut at PROSE_PREVIEW_CHARS with a marker", () => {
  const prose = Array.from({ length: 60 }, () => "word").join(" "); // 299 chars
  const d = details(5, { provider: "openai", answer: prose });
  const view = searchView(d, { expanded: false, query: "q" });
  const cut = truncateToWidth(prose, PROSE_PREVIEW_CHARS, "…").replace(/\x1b\[0m/g, "");
  assert.equal(unwrap(view.answer!), cut);
  assert.ok(stripTerminalSequences(cut).length <= PROSE_PREVIEW_CHARS);
  assert.ok(stripTerminalSequences(cut).endsWith("…"));
  // The row collapse contract is untouched by the answer block.
  assert.equal(view.rows.length, COLLAPSED_ROWS);
  assert.equal(view.hiddenCount, 5 - COLLAPSED_ROWS);
});

test("answer: a short answer shows in full when collapsed, no cut marker", () => {
  const d = details(5, { provider: "openai", answer: "  a  short   answer " });
  const view = searchView(d, { expanded: false, query: "q" });
  assert.deepEqual(view.answer, ["   a short answer"]);
});

test("answer: expanded carries the whole whitespace-normalized prose", () => {
  const prose = Array.from({ length: 60 }, () => "word").join(" ");
  const d = details(5, { provider: "openai", answer: prose });
  const view = searchView(d, { expanded: true, query: "q" });
  assert.equal(unwrap(view.answer!), prose);
});

test("answer: markdown markers are stripped for display", () => {
  const d = details(5, {
    provider: "openai",
    answer: "It is **v24.22.0** with `util.throttle()` — see [nodejs.org](https://nodejs.org/en/blog/release) for notes.",
  });
  const view = searchView(d, { expanded: true, query: "q" });
  const raw = unwrap(view.answer!);
  // Links keep the full target as an OSC 8 hyperlink; only the label shows.
  assert.ok(raw.includes("https://nodejs.org/en/blog/release"));
  assert.equal(
    stripTerminalSequences(raw),
    "It is v24.22.0 with util.throttle() — see nodejs.org for notes.",
  );
});

test("answer: wrapped lines keep a hanging indent within the block width", () => {
  const d = details(5, { provider: "openai", answer: "word ".repeat(60).trim() });
  const view = searchView(d, { expanded: false, query: "q" });
  assert.ok(view.answer!.length > 1);
  assert.ok(view.answer!.every((l) => l.startsWith("   ")));
  assert.ok(view.answer!.every((l) => l.length <= PROSE_WRAP_COLS + 3));
});

test("answer: zero citations with prose shapes as a success, not a miss", () => {
  const d = details(0, { provider: "openai", answer: "grounded prose" });
  const view = searchView(d, { expanded: false, query: "q" });
  assert.equal(view.count, 0);
  assert.equal(view.answer!.length, 1);
  assert.equal(view.rows.length, 0);
});

test("answer: absent from details leaves the view unchanged", () => {
  const view = searchView(details(5), { expanded: false, query: "q" });
  assert.equal(view.answer, undefined);
});

test("rows: an untitled citation shows its URL once, shortened, as the link", () => {
  const d = details(1);
  d.results![0]!.title = "https://nodejs.org/en/blog/release/v26.0.0";
  d.results![0]!.url = "https://nodejs.org/en/blog/release/v26.0.0";
  const view = searchView(d, { expanded: false, query: "q" });
  assert.equal(view.rows[0]!.title, "nodejs.org/en/blog/release/v26.0.0");
  assert.equal(view.rows[0]!.url, "https://nodejs.org/en/blog/release/v26.0.0");
  assert.equal(view.rows[0]!.titleIsUrl, true);
});

test("rows: titled rows keep title and url, not marked as url-titled", () => {
  const view = searchView(details(1), { expanded: false, query: "q" });
  assert.equal(view.rows[0]!.title, "Title 1");
  assert.equal(view.rows[0]!.url, "https://example.com/1");
  assert.equal(view.rows[0]!.titleIsUrl, false);
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
    titleIsUrl: false,
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
  assert.ok(lines.every((l) => l.length <= PROSE_WRAP_COLS + 3));
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

// ── papersView ───────────────────────────────────────────────────────────────────────

function paperRow(extra: Partial<WebSearchDetailsRow> = {}): WebSearchDetailsRow {
  return {
    title: "Lichen Biology",
    url: "https://example.org/works/W1",
    snippet: "Cambridge University Press · 2008 · 414 citations",
    fwci: 5.4933,
    doi: "10.1017/cbo9780511790478",
    oaUrl: "https://example.org/oa/W1",
    recentCitations: 96,
    citationTrend: "steady",
    abstract: "  Lichens are   symbiotic organisms.  ",
    ...extra,
  };
}

function paperDetails(n: number, extra: Partial<WebSearchDetails> = {}): WebSearchDetails {
  return {
    provider: "papers",
    resultCount: n,
    results: Array.from({ length: n }, () => paperRow()),
    ...extra,
  };
}

test("papers: collapsed caps rows, keeps the ranking line, hides expanded-only fields", () => {
  const view = papersView(paperDetails(10), { expanded: false, query: "lichen" });
  assert.equal(view.rows.length, COLLAPSED_ROWS);
  assert.equal(view.hiddenCount, 10 - COLLAPSED_ROWS);
  assert.ok(
    view.rows.every((r) =>
      r.summary === "Cambridge University Press · 2008 · 414 citations · fwci 5.5"
    ),
  );
  assert.ok(
    view.rows.every((r) =>
      r.trend === undefined && r.abstract === undefined
    ),
  );
  // linkTarget is required data even collapsed — the renderer hides it, the
  // view still carries it.
  assert.ok(view.rows.every((r) => r.linkTarget === "https://example.org/oa/W1"));
});

test("papers: expanded reveals link, trend, and abstract on every row", () => {
  const view = papersView(paperDetails(2), { expanded: true, query: "lichen" });
  assert.equal(view.rows.length, 2);
  assert.equal(view.hiddenCount, 0);
  assert.ok(view.rows.every((r) => r.linkTarget === "https://example.org/oa/W1"));
  assert.ok(view.rows.every((r) => r.trend === "96 recent (steady)"));
  assert.ok(view.rows.every((r) => r.abstract === "Lichens are symbiotic organisms."));
});

test("papers: the link prefers the OA URL, falls back to doi.org, then the row URL", () => {
  const noOa = papersView(
    paperDetails(1, { results: [paperRow({ oaUrl: undefined })] }),
    { expanded: true, query: "q" },
  );
  assert.equal(noOa.rows[0]!.linkTarget, "https://doi.org/10.1017/cbo9780511790478");
  const neither = papersView(
    paperDetails(1, {
      results: [paperRow({ oaUrl: undefined, doi: undefined, url: "https://pubmed.example/W1" })],
    }),
    { expanded: true, query: "q" },
  );
  assert.equal(neither.rows[0]!.linkTarget, "https://pubmed.example/W1");
});

test("papers: absent fields invent nothing", () => {
  const view = papersView(
    paperDetails(1, { results: [{ title: "Bare Work", url: "https://example.org/W", snippet: "" }] }),
    { expanded: true, query: "q" },
  );
  const r = view.rows[0]!;
  assert.equal(r.title, "Bare Work");
  assert.equal(r.summary, undefined);
  // Nothing invented: the only link available is the row's own URL.
  assert.equal(r.linkTarget, "https://example.org/W");
  assert.equal(r.trend, undefined);
  assert.equal(r.abstract, undefined);
});

test("papers: a short page hides nothing; retracted-false renders like no field", () => {
  const view = papersView(
    paperDetails(2, { results: [paperRow({ retracted: false }), paperRow()] }),
    { expanded: false, query: "q" },
  );
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows[0]!.summary, view.rows[1]!.summary);
});

test("papers: abstract excerpt caps at SNIPPET_CHARS with the cap marked", () => {
  const long = "x".repeat(SNIPPET_CHARS * 2);
  const view = papersView(
    paperDetails(1, { results: [paperRow({ abstract: long })] }),
    { expanded: true, query: "q" },
  );
  assert.equal(stripTerminalSequences(view.rows[0]!.abstract!).length, SNIPPET_CHARS);
  assert.ok(stripTerminalSequences(view.rows[0]!.abstract!).endsWith("…"));
});

test("papers: nextCursor and error pass through", () => {
  const view = papersView(paperDetails(1, { nextCursor: "cur-1" }), { expanded: false, query: "q" });
  assert.equal(view.nextCursor, "cur-1");
  const err = papersView(
    { provider: "papers", error: "OpenAlex was unreachable" },
    { expanded: true, query: "q" },
  );
  assert.equal(err.error, "OpenAlex was unreachable");
  assert.equal(err.count, 0);
});

// ── Fetch view ───────────────────────────────────────────────────────────────

function fetchDetails(n: number, extra: Partial<FetchDetails> = {}): FetchDetails {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      url: `https://example.com/page-${i + 1}`,
      title: `Page ${i + 1}`,
      content: `Content of page ${i + 1}. `.repeat(40),
      error: null,
    })),
    ...extra,
  };
}

test("fetch collapsed: caps rows at COLLAPSED_ROWS, counts hidden, no previews", () => {
  const view = fetchView(fetchDetails(5), { expanded: false });
  assert.equal(view.rows.length, COLLAPSED_ROWS);
  assert.equal(view.hiddenCount, 5 - COLLAPSED_ROWS);
  assert.ok(view.rows.every((r) => r.preview === undefined));
  assert.equal(view.rows[0]!.chars, fetchDetails(1).results![0]!.content.length);
});

test("fetch expanded: every page carries a hanging-indented preview cut at FETCH_PREVIEW_CHARS", () => {
  const view = fetchView(fetchDetails(2), { expanded: true });
  assert.equal(view.rows.length, 2);
  assert.equal(view.hiddenCount, 0);
  const lines = view.rows[0]!.preview!;
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.startsWith("   ")));
  const preview = stripTerminalSequences(lines.join(""));
  assert.ok(stripTerminalSequences(lines.join("")).length <= FETCH_PREVIEW_CHARS + 4 * lines.length);
  assert.ok(preview.endsWith("…"));
});

test("fetch: a truncated cut carries no style resets — the black-band bug", () => {
  // truncateToWidth injects \x1b[0m before the ellipsis on every cut; inside a
  // styled wrapped block that reset kills the row background (black band).
  const prose = Array.from({ length: 120 }, () => "word").join(" "); // 599 chars — past the budget
  const d = fetchDetails(1);
  d.results![0]!.content = prose;
  const preview = fetchView(d, { expanded: true }).rows[0]!.preview!.join("");
  assert.ok(!preview.includes("\x1b"));
  assert.ok(stripTerminalSequences(preview).endsWith("…"));
});

test("fetch: an untitled page falls back to its shortened URL as title", () => {
  const d = fetchDetails(1);
  d.results![0]!.title = "";
  const view = fetchView(d, { expanded: false });
  assert.equal(view.rows[0]!.title, "example.com/page-1");
});

test("fetch: a failed page carries its error and no preview even expanded", () => {
  const d = fetchDetails(2, {});
  d.results![0]!.error = "Fetch failed (HTTP 404). The URL may require authentication.";
  const view = fetchView(d, { expanded: true });
  assert.equal(view.rows[0]!.error, "Fetch failed (HTTP 404). The URL may require authentication.");
  assert.equal(view.rows[0]!.preview, undefined);
  assert.ok(view.rows[1]!.preview);
});

test("fetch summarized: model rides, summary pre-wrapped and preview-cut collapsed", () => {
  const prose = Array.from({ length: 60 }, () => "word").join(" ");
  const d = fetchDetails(2, { summarized: true, model: "gpt-x", summary: prose });
  const collapsed = fetchView(d, { expanded: false });
  assert.equal(collapsed.model, "gpt-x");
  assert.ok(collapsed.summary!.length > 1);
  assert.ok(collapsed.summary!.every((l) => l.startsWith("   ")));
  assert.ok(stripTerminalSequences(unwrap(collapsed.summary!)).endsWith("…"));
  const expanded = fetchView(d, { expanded: true });
  assert.equal(unwrap(expanded.summary!), prose);
});

test("fetch: formatChars humanizes sizes", () => {
  assert.equal(formatChars(850), "850 chars");
  assert.equal(formatChars(12345), "12.3k chars");
});
