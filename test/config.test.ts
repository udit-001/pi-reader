// Tests for pi-web's own config file — the key residency seam. Load/save
// against real files in a temp dir; missing and malformed both read as null
// (our file, self-healing on the next save).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, saveConfig } from "../config.ts";

test("config: configPath points at ~/.pi/agent/pi-web.json", () => {
  assert.ok(configPath().endsWith(join(".pi", "agent", "pi-web.json")));
});

test("config: loadConfig returns null when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-config-"));
  try {
    assert.equal(loadConfig(join(dir, "pi-web.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: saveConfig then loadConfig round-trips, creating parent dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-config-"));
  const nested = join(dir, "deep", "pi-web.json");
  try {
    saveConfig(nested, {
      version: 1,
      exa: { url: "https://mcp.exa.ai/mcp", apiKey: "k1" },
      hints: { mcpDuplicate: "2026-09-18T00:00:00.000Z" },
    });
    assert.ok(existsSync(nested));
    assert.deepEqual(loadConfig(nested), {
      version: 1,
      exa: { url: "https://mcp.exa.ai/mcp", apiKey: "k1" },
      hints: { mcpDuplicate: "2026-09-18T00:00:00.000Z" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: malformed JSON reads as null, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-config-"));
  const path = join(dir, "pi-web.json");
  try {
    writeFileSync(path, "{ oops");
    assert.equal(loadConfig(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: saveConfig writes readable JSON with a trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-config-"));
  const path = join(dir, "pi-web.json");
  try {
    saveConfig(path, { version: 1, exa: { url: "https://mcp.exa.ai/mcp", apiKey: "k1" } });
    const text = readFileSync(path, "utf-8");
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(JSON.parse(text).exa, { url: "https://mcp.exa.ai/mcp", apiKey: "k1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
