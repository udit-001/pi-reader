// Tests for the fetch module's converter — the pure part of the URL→Markdown
// pipeline. Everything that needs the network is behind the fetchContent()
// interface and is exercised as an integration test instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { htmlToMarkdown, convert, fitToBudget, normalizeUrl, rawContentLabel } from "../fetch/fetch.ts";

test("fetch: converts a simple article to clean markdown", () => {
  const html = `
<!DOCTYPE html>
<html>
<head><title>My Great Post</title></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
  <h1>Hello World</h1>
  <p>This is a <strong>bold</strong> and <em>italic</em> sentence with a <a href="https://x.dev">link</a>.</p>
  <ul>
    <li>first item</li>
    <li>second item</li>
  </ul>
  <pre><code>const x = 1;</code></pre>
  <blockquote>A wise quote</blockquote>
</article>
<footer>Copyright 2026</footer>
</body>
</html>
`;
  const md = htmlToMarkdown(html);
  assert.match(md, /^# Hello World/);
  assert.match(md, /bold/i);
  assert.match(md, /\[link\]\(https:\/\/x\.dev\)/);
  assert.match(md, /- first item/);
  assert.match(md, /```/);
  assert.match(md, /> A wise quote/);
  assert.ok(!md.includes("<script"));
  // nav and footer removed — article landmark wins
  assert.ok(!md.includes("Home"));
  assert.ok(!md.includes("Copyright"));
});

test("fetch: convert() sniffs JSON content type", () => {
  const { title, content } = convert(
    '{"a": 1, "b": [1,2,3]}',
    "application/json",
    "https://api.example.com/data.json",
  );
  assert.match(content, /```json/);
  assert.match(content, /"a": 1/);
  assert.ok(title.endsWith("data.json"));
});

test("fetch: convert() treats plain text as text, preserving newlines", () => {
  const { content } = convert(
    "line one\nline two\n  spaced   text",
    "text/plain",
    "https://example.com/file.txt",
  );
  assert.match(content, /line one\nline two/);
});

test("fetch: convert() returns text/markdown verbatim with heading title", () => {
  const body = "# Documentation\n\nSome *intro* text.\n\n## Installation\n\n```bash\nnpm install defuddle\n```\n";
  const { title, content } = convert(body, "text/markdown; charset=utf-8", "https://defuddle.md/docs.md");
  assert.equal(title, "Documentation");
  assert.equal(content, body.trim());
  assert.ok(content.includes("## Installation"));
});

test("fetch: convert() detects markdown by .md URL even without content type", () => {
  const body = "# Title Here\n\nbody text\n";
  const { title, content } = convert(body, "", "https://example.com/readme.md");
  assert.equal(title, "Title Here");
  assert.equal(content, body.trim());
});

test("fetch: convert() extracts title from HTML", () => {
  const { title } = convert(
    "<html><head><title>Document Title</title></head><body><p>Body text</p></body></html>",
    "text/html",
    "https://example.com/doc",
  );
  assert.equal(title, "Document Title");
});

test("fetch: convert() respects maxChars", () => {
  const { content } = convert(
    "<html><body><p>" + "a".repeat(10_000) + "</p></body></html>",
    "text/html",
    "https://example.com/big",
    500,
  );
  assert.ok(content.length <= 500);
});
test("normalizeUrl: passes through clean URLs", () => {
  assert.equal(normalizeUrl("https://example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000");
});

test("normalizeUrl: extracts URL from JSON-stringified array", () => {
  // The MCP layer sometimes stringifies URL arrays before they reach us.
  // This is the exact error pattern: [\"https://...\"] gets passed to fetch().
  const stringified = JSON.stringify(["https://example.com"]);
  assert.equal(normalizeUrl(stringified), "https://example.com");
});

test("normalizeUrl: handles malformed JSON gracefully", () => {
  assert.equal(normalizeUrl("[not-json"), "[not-json");
  assert.equal(normalizeUrl("[]"), "[]");
});

test("fetch: fitToBudget keeps short content as-is", () => {
  const fit = fitToBudget("short content", 100);
  assert.equal(fit.truncated, false);
  assert.equal(fit.text, "short content");
});

test("fetch: fitToBudget keeps head+tail with an explicit marker", () => {
  const body = "H".repeat(9000) + "T".repeat(1000);
  const fit = fitToBudget(body, 2000);
  assert.equal(fit.truncated, true);
  assert.ok(fit.text.startsWith("H".repeat(10)));
  assert.ok(fit.text.endsWith("T".repeat(10)));
  assert.match(fit.text, /\[\.\.\.TRUNCATED 8100 characters\.\.\.\]/);
  assert.ok(fit.text.length <= 2000 + 50); // marker overhead only
});

test("fetch: rawContentLabel formats status and content type", () => {
  assert.equal(rawContentLabel(200, "text/html; charset=utf-8"), "[status: 200 | content-type: text/html; charset=utf-8]");
  assert.equal(rawContentLabel(403, ""), "[status: 403 | content-type: unknown]");
});

test("fetch: every transport in fetch.ts goes through httpGet (per-hop SSRF validation)", () => {
  // Contract from docs/fetch-pipeline.md: "Route new fetch paths through httpGet
  // so they inherit the guard." A raw fetch() with redirect:"follow" follows
  // redirect hops to loopback/private addresses without re-validating (SSRF).
  // Behavioral testing is not possible here (hop 0 to a loopback server is
  // already blocked, and a "public" initial host needs live DNS), so this pins
  // the source-level contract instead: no native-redirect transports in fetch.ts.
  const source = readFileSync(new URL("../fetch/fetch.ts", import.meta.url), "utf-8");
  assert.ok(
    !source.includes("redirect:"),
    "fetch.ts must not configure native redirects — transport belongs to httpGet, which re-validates every hop",
  );
  const directFetches = source.match(/\bfetch\s*\(/g) ?? [];
  // Exactly one direct fetch(): inside fetchWithTimeout, used only by the two
  // fixed-host fallback services (r.jina.ai, markdown.new — no user-controlled
  // host, so no SSRF surface). Every user-URL transport must go through httpGet.
  assert.equal(
    directFetches.length, 1,
    `expected exactly one direct fetch( (fetchWithTimeout, fixed-host fallbacks), found ${directFetches.length}`,
  );
});
