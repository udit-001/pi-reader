// Tests for the DuckDuckGo adapter's parse seam.
// Raw HTML fixtures mirror what html.duckduckgo.com/html/ actually returns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../duckduckgo.ts";

const FIXTURE = `
<!DOCTYPE html>
<html>
<body>
<form id="search_form" action="/html/" method="post">
  <input type="text" name="q">
</form>
<div class="result results_links results_links_deep web-result" id="r1-0">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&rut=abc">Example Domain Guide</a>
    </h2>
    <div class="result__snippet">
      <a rel="nofollow" class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&rut=abc">
        The <b>complete</b> guide &amp; reference for example.com users.
      </a>
    </div>
  </div>
</div>
<div class="result results_links results_links_deep web-result" id="r2-1">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://docs.example.com/setup">Example Docs: Setup</a>
    </h2>
    <div class="result__snippet">
      <a rel="nofollow" class="result__snippet" href="https://docs.example.com/setup">
        Setup instructions and troubleshooting for first-time installs.
      </a>
    </div>
  </div>
</div>
<div class="result result--ad results_links_deep web-result" id="r3-2">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://ads.example.com">Sponsored Result</a>
    </h2>
  </div>
</div>
</body>
</html>
`;

test("duckduckgo: parses results, decodes redirect URLs, decodes entities", () => {
  const results = parseResults(FIXTURE);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, "Example Domain Guide");
  assert.equal(results[0]!.url, "https://example.com/guide");
  assert.equal(results[0]!.snippet, "The complete guide & reference for example.com users.");
  assert.equal(results[1]!.url, "https://docs.example.com/setup");
});

test("duckduckgo: skips ad blocks", () => {
  const results = parseResults(FIXTURE);
  assert.ok(!results.some((r) => r.url.includes("ads.example.com")));
});

test("duckduckgo: respects numResults limit", () => {
  const results = parseResults(FIXTURE, { numResults: 1 });
  assert.equal(results.length, 1);
});

test("duckduckgo: domain include filter", () => {
  const results = parseResults(FIXTURE, { domains: ["docs.example.com"] });
  assert.equal(results.length, 1);
  assert.ok(results[0]!.url.startsWith("https://docs.example.com"));
});

test("duckduckgo: domain exclude filter", () => {
  const results = parseResults(FIXTURE, { domains: ["-docs.example.com"] });
  assert.equal(results.length, 1);
  assert.ok(results[0]!.url.startsWith("https://example.com"));
});

test("duckduckgo: no results when the page is a bot challenge", () => {
  const results = parseResults("<html><body>anomaly detected</body></html>");
  assert.equal(results.length, 0);
});