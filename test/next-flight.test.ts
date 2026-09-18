// Tests for the Next.js RSC flight extractor. The module is pure, so tests
// cross the same seam the caller does: extractNextFlightContent(html) with
// inline fixture pages. Fixtures mirror what App Router pages actually embed:
// inline scripts pushing JSON-string-escaped "hexId:payload" fragments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNextFlightContent } from "../handlers/next-flight.ts";

/** Build a fake App Router page from raw chunk strings ("23:[...]") — flightPage performs the single wire escaping. */
function flightPage(chunks: string[], title = "Docs | Example"): string {
  const scripts = chunks
    .map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
    .join("\n");
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${scripts}</body></html>`;
}

/** Flight chunk: "hexId:" + JSON of the element tree. */
const chunk = (id: string, node: unknown): string => `${id}:${JSON.stringify(node)}`;
const el = (tag: string, props: Record<string, unknown>): unknown[] => ["$", tag, null, props];
const children = (...nodes: unknown[]): unknown[] => nodes;

test("flight: walks the main chunk tree to markdown", () => {
  const main = chunk("23", el("div", {
    children: children(
      el("h1", { children: "Install Guide" }),
      el("p", { children: "Run the installer and follow the prompts. The installer detects your platform automatically, downloads the matching binary, and verifies its checksum before placing it on your PATH." }),
      el("ul", { children: children(el("li", { children: "first step" }), el("li", { children: "second step" })) }),
    ),
  }));
  const out = extractNextFlightContent(flightPage([main]));
  assert.ok(out, "should extract content");
  // Title splitting keeps the page name from "Page | Site" titles
  assert.equal(out.title, "Docs");
  assert.match(out.content, /^# Install Guide/);
  assert.match(out.content, /Run the installer and follow the prompts\./);
  assert.match(out.content, /- first step\n- second step/);
});

test("flight: resolves $L refs across chunks", () => {
  const chunks = [
    chunk("23", el("div", { children: "$L2" })),
    chunk("2", el("article", {
      children: children(
        el("h2", { children: "Cross-chunk section" }),
        el("p", {
          children:
            "Body text from the referenced chunk. This paragraph lives in a different payload row than the main layout chunk, which is exactly the shape streamed pages produce.",
        }),
      ),
    })),
  ];
  const out = extractNextFlightContent(flightPage(chunks));
  assert.ok(out);
  assert.match(out.content, /## Cross-chunk section/);
  assert.match(out.content, /Body text from the referenced chunk\./);
});

test("flight: renders a table with header separator", () => {
  const table = el("table", {
    children: children(
      el("thead", { children: el("tr", { children: children(el("th", { children: "Name" }), el("th", { children: "Size" })) }) }),
      el("tbody", { children: el("tr", { children: children(el("td", { children: "alpha" }), el("td", { children: "3 MB, compressed to 1.1 MB on disk after the build step finishes" })) }) }),
    ),
  });
  const main = chunk("23", el("div", { children: table }));
  const out = extractNextFlightContent(flightPage([main]));
  assert.ok(out);
  assert.match(out.content, /\| Name \| Size \|/);
  assert.match(out.content, /\| --- \| --- \|/);
  assert.match(out.content, /\| alpha \| 3 MB, compressed/);
});

test("flight: skips non-content tags and renders code/links", () => {
  const main = chunk("23", el("div", {
    children: children(
      el("nav", { children: "Home About Contact" }),
      el("p", {
        children: children(
          "See ",
          el("a", { href: "https://example.com/docs", children: "the docs" }),
          " and ",
          el("code", { children: "npm i x" }),
          " today. The rest of this paragraph exists so the rendered markdown clears the extractor's minimum content length without changing what is being asserted." ,
        ),
      }),
    ),
  }));
  const out = extractNextFlightContent(flightPage([main]));
  assert.ok(out);
  assert.ok(!out.content.includes("Home About Contact"));
  assert.match(out.content, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(out.content, /`npm i x`/);
});

test("flight: cycle-safe on self-referencing chunks", () => {
  const selfRef = chunk("5", el("p", { children: "$L5" }));
  const main = chunk("23", el("div", { children: "$L5" }));
  const out = extractNextFlightContent(flightPage([selfRef, main]));
  // No hang; cycle renders empty → thin → null
  assert.equal(out, null);
});

test("flight: falls back to a thin main chunk by sweeping remaining chunks", () => {
  const thinMain = chunk("23", el("div", { children: "tiny" }));
  const body = chunk("7", el("section", {
    children: children(
      el("h1", { children: "Full Content Lives Here" }),
      el("p", { children: "The page body was streamed into this later chunk instead of the main one, which happens when a route defers its shell and hydrates sections independently." }),
    ),
  }));
  const out = extractNextFlightContent(flightPage([thinMain, body]));
  assert.ok(out);
  assert.match(out.content, /# Full Content Lives Here/);
});

test("flight: returns null for non-flight pages and unparseable chunks", () => {
  assert.equal(extractNextFlightContent("<html><body><p>plain page</p></body></html>"), null);
  assert.equal(extractNextFlightContent("<html><body><script>self.__next_f.push([1,'not-json'])</script></body></html>"), null);
  const empty = flightPage([chunk("23", el("div", { children: "" }))]);
  assert.equal(extractNextFlightContent(empty), null);
});
