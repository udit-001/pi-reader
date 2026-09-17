// Tests for the exa-setup write seam — pure transforms on config text, and
// upsert behavior against real temp files (create, preserve, never clobber).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exaUrlWithKey, maskKeyInUrl, redact, upsertExaKey, withExaKey } from "../exa-setup.ts";

test("exa-setup: exaUrlWithKey builds a default URL with tools filter", () => {
  const url = exaUrlWithKey(undefined, "my-key");
  assert.equal(url, "https://mcp.exa.ai/mcp?tools=web_search_exa%2Cweb_fetch_exa%2Cweb_search_advanced_exa&exaApiKey=my-key");
});

test("exa-setup: exaUrlWithKey replaces the key and preserves other params", () => {
  const existing = "https://mcp.exa.ai/mcp?exaApiKey=old-key&tools=web_search_exa&custom=1";
  const url = exaUrlWithKey(existing, "new-key");
  const u = new URL(url);
  assert.equal(u.searchParams.get("exaApiKey"), "new-key");
  assert.equal(u.searchParams.get("tools"), "web_search_exa");
  assert.equal(u.searchParams.get("custom"), "1");
});

test("exa-setup: maskKeyInUrl hides the key value", () => {
  const masked = maskKeyInUrl(exaUrlWithKey(undefined, "secret-key-value"));
  assert.ok(!masked.includes("secret-key-value"));
  assert.ok(masked.includes("exaApiKey="));
  assert.ok(masked.includes("•"));
});

test("exa-setup: redact scrubs the secret from text", () => {
  assert.equal(redact("error at secret-key-value end", "secret-key-value"), "error at [redacted] end");
});

test("exa-setup: withExaKey creates a fresh config with the pi-native shape", () => {
  const { text, entry } = withExaKey(null, "k1");
  const parsed = JSON.parse(text);
  assert.equal(parsed.mcpServers.exa.type, "streamable-http");
  assert.equal(new URL(entry.url as string).searchParams.get("exaApiKey"), "k1");
  assert.ok((entry.url as string).includes("tools="));
  assert.ok(text.endsWith("\n"));
});

test("exa-setup: withExaKey upserts into an existing entry, preserving siblings", () => {
  const current = JSON.stringify({
    mcpServers: {
      deepwiki: { type: "streamable-http", url: "https://mcp.deepwiki.com/mcp" },
      exa: { type: "streamable-http", directTools: true, url: "https://mcp.exa.ai/mcp?exaApiKey=stale&tools=web_search_exa" },
    },
  });
  const { text, entry } = withExaKey(current, "fresh");
  const parsed = JSON.parse(text);
  // sibling server untouched
  assert.equal(parsed.mcpServers.deepwiki.url, "https://mcp.deepwiki.com/mcp");
  // exa entry: key replaced, tools preserved, siblings kept
  assert.equal(entry.directTools, true);
  assert.equal(new URL(entry.url as string).searchParams.get("exaApiKey"), "fresh");
  assert.equal(new URL(entry.url as string).searchParams.get("tools"), "web_search_exa");
});

test("exa-setup: withExaKey rejects malformed JSON without touching anything", () => {
  assert.throws(() => withExaKey("{ not json", "k"), /not valid JSON/);
  assert.throws(() => withExaKey("[1,2,3]", "k"), /JSON object/);
});

test("exa-setup: upsertExaKey creates, updates, and never clobbers malformed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-exa-setup-"));
  const path = join(dir, "mcp.json");
  try {
    // create
    upsertExaKey(path, "first");
    const created = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(new URL(created.mcpServers.exa.url).searchParams.get("exaApiKey"), "first");

    // update: siblings survive
    writeFileSync(path, JSON.stringify({
      mcpServers: { other: { url: "https://x.example/mcp" }, exa: { directTools: false, url: created.mcpServers.exa.url } },
    }, null, 2));
    upsertExaKey(path, "second");
    const updated = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(updated.mcpServers.other.url, "https://x.example/mcp");
    assert.equal(updated.mcpServers.exa.directTools, false);
    assert.equal(new URL(updated.mcpServers.exa.url).searchParams.get("exaApiKey"), "second");

    // malformed: throws, file unchanged
    const broken = "{ oops";
    writeFileSync(path, broken);
    assert.throws(() => upsertExaKey(path, "third"), /not valid JSON/);
    assert.equal(readFileSync(path, "utf-8"), broken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
