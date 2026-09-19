// Tests for the exa-setup seams: mcp.json detection (read-only import source)
// and removal (opt-in dedup surgery, never clobber), plus secret redaction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, findMcpExaEntry, removeMcpExaEntry } from "../search/exa-setup.ts";

test("exa-setup: findMcpExaEntry finds the key, url, and directTools flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reader-mcp-"));
  const path = join(dir, "mcp.json");
  try {
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        exa: { type: "streamable-http", directTools: true, url: "https://mcp.exa.ai/mcp?exaApiKey=old&tools=web_search_exa" },
      },
    }));
    const found = findMcpExaEntry(path);
    assert.ok(found);
    assert.equal(found.apiKey, "old");
    assert.equal(found.directTools, true);
    assert.equal(found.url, "https://mcp.exa.ai/mcp?exaApiKey=old&tools=web_search_exa");
    assert.equal(findMcpExaEntry(join(dir, "none.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exa-setup: findMcpExaEntry returns null for malformed configs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reader-mcp-"));
  const path = join(dir, "mcp.json");
  try {
    writeFileSync(path, "{ oops");
    assert.equal(findMcpExaEntry(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exa-setup: removeMcpExaEntry deletes only the exa server, never clobbers malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reader-mcp-"));
  const path = join(dir, "mcp.json");
  try {
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
        exa: { type: "streamable-http", directTools: true, url: "https://mcp.exa.ai/mcp?exaApiKey=old" },
      },
    }, null, 2));
    removeMcpExaEntry(path);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual(Object.keys(after.mcpServers), ["deepwiki"]);

    const broken = "{ oops";
    writeFileSync(path, broken);
    assert.throws(() => removeMcpExaEntry(path), /not valid JSON/);
    assert.equal(readFileSync(path, "utf-8"), broken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exa-setup: redact scrubs the secret from text", () => {
  assert.equal(redact("error at secret-key-value end", "secret-key-value"), "error at [redacted] end");
});
