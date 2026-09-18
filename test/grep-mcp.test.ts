// Tests for the grep.app MCP adapter's parse seam: normalizeGrepResults turns
// searchGitHub's text blocks (Repository/Path/URL/License + Snippets) into
// SearchResults. Fixtures mirror what the live server returns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGrepResults } from "../grep-mcp.ts";

const FIXTURE = `Repository: mifi/lossless-cut
Path: src/renderer/src/hooks/useUserSettingsRoot.ts
URL: https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/hooks/useUserSettingsRoot.ts
License: GPL-2.0

Snippets:
--- Snippet 1 (Line 54) ---
  const [lastAppVersion, setLastAppVersion] = useState(safeGetConfigInitial('lastAppVersion'));
  useEffect(() => safeSetConfig({ lastAppVersion }), [lastAppVersion]);
--- Snippet 2 (Line 99) ---
  const [captureFormat, setCaptureFormat] = useState(safeGetConfigInitial('captureFormat'));

Repository: vercel/ai
Path: examples/next-openai/app/page.tsx
URL: https://github.com/vercel/ai/blob/main/examples/next-openai/app/page.tsx

Snippets:
--- Snippet 1 (Line 12) ---
const response = await streamText({ model, prompt });`;

test("grep: normalizes searchGitHub text blocks into results", () => {
  const results = normalizeGrepResults(FIXTURE);
  assert.equal(results.length, 2);

  assert.equal(results[0]!.title, "mifi/lossless-cut · src/renderer/src/hooks/useUserSettingsRoot.ts");
  assert.equal(results[0]!.url, "https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/hooks/useUserSettingsRoot.ts");
  // snippet = first snippet, whitespace-collapsed, marker dropped
  assert.equal(
    results[0]!.snippet,
    "const [lastAppVersion, setLastAppVersion] = useState(safeGetConfigInitial('lastAppVersion')); useEffect(() => safeSetConfig({ lastAppVersion }), [lastAppVersion]);",
  );
  // content keeps every snippet with its line-number marker
  assert.match(results[0]!.content!, /--- Snippet 1 \(Line 54\) ---/);
  assert.match(results[0]!.content!, /--- Snippet 2 \(Line 99\) ---/);
  assert.match(results[0]!.content!, /captureFormat/);

  assert.equal(results[1]!.title, "vercel/ai · examples/next-openai/app/page.tsx");
  assert.equal(results[1]!.snippet, "const response = await streamText({ model, prompt });");
});

test("grep: skips blocks without a URL instead of failing the batch", () => {
  const text = `Repository: broken/block
Path: only/partial.ts

Repository: vercel/ai
Path: app/page.tsx
URL: https://github.com/vercel/ai/blob/main/app/page.tsx

Snippets:
--- Snippet 1 (Line 3) ---
export {};`;
  const results = normalizeGrepResults(text);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, "https://github.com/vercel/ai/blob/main/app/page.tsx");
});

test("grep: returns an empty result set for genuine no-match responses", () => {
  assert.deepEqual(normalizeGrepResults("No results found for your query."), []);
  assert.deepEqual(normalizeGrepResults(""), []);
});
