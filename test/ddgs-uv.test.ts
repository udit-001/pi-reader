// Tests for the ddgs-uv module — uvx availability detection and path resolution.
// No network calls; tests the detection logic only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUvx, uvxInstallPath, uvInstallCommand, probeCommands, warmFlow, warmDdgs, timelimitFor, buildDdgsTextCommand } from "../search/ddgs-uv.ts";
import { join } from "node:path";

test("ddgs-uv: hasUvx returns a boolean", () => {
  const result = hasUvx();
  assert.equal(typeof result, "boolean");
});

test("ddgs-uv: hasUvx is consistent across calls", () => {
  const first = hasUvx();
  const second = hasUvx();
  assert.equal(first, second);
});

test("ddgs-uv: uvxInstallPath on unix is ~/.local/bin/uvx", () => {
  assert.equal(uvxInstallPath("linux", "/home/u"), "/home/u/.local/bin/uvx");
  assert.equal(uvxInstallPath("darwin", "/Users/u"), "/Users/u/.local/bin/uvx");
});

test("ddgs-uv: uvxInstallPath on windows is ~/.local/bin/uvx.exe", () => {
  assert.equal(uvxInstallPath("win32", join("C:", "Users", "u")), join("C:", "Users", "u", ".local", "bin", "uvx.exe"));
});

test("ddgs-uv: uvInstallCommand uses the platform installer", () => {
  assert.match(uvInstallCommand("linux"), /astral\.sh\/uv\/install\.sh/);
  assert.match(uvInstallCommand("darwin"), /astral\.sh\/uv\/install\.sh/);
  assert.match(uvInstallCommand("win32"), /install\.ps1/);
});

test("ddgs-uv: probeCommands tries the install location, then PATH", () => {
  const plan = probeCommands("win32", join("C:", "Users", "u"));
  assert.equal(plan.length, 2);
  assert.match(plan[0]!, /uvx\.exe" ddgs/);
  assert.equal(plan[1], "uvx ddgs --help");
});

test("ddgs-uv: warmFlow stops at the first successful probe", async () => {
  const calls: string[] = [];
  await warmFlow(async (cmd) => { calls.push(cmd); }, ["p1 ddgs --help", "p2 ddgs --help"], "install-cmd");
  assert.deepEqual(calls, ["p1 ddgs --help"]); // no install, no further probes
});

test("ddgs-uv: warmFlow falls back to PATH before installing", async () => {
  const calls: string[] = [];
  await warmFlow(
    async (cmd) => {
      calls.push(cmd);
      if (cmd !== "PATH-PROBE") throw new Error("not found");
    },
    ["INSTALL-PROBE", "PATH-PROBE"],
    "INSTALL-CMD",
  );
  assert.deepEqual(calls, ["INSTALL-PROBE", "PATH-PROBE"]); // install never ran
});

test("ddgs-uv: warmFlow installs only after all probes fail, then retries", async () => {
  const calls: string[] = [];
  await warmFlow(
    async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("PROBE")) throw new Error("fail"); // install succeeds, probe retries
    },
    ["PROBE-1", "PROBE-2"],
    "INSTALL",
  );
  assert.deepEqual(calls, ["PROBE-1", "PROBE-2", "INSTALL", "PROBE-1"]);
});

test("ddgs-uv: warmFlow gives up quietly when install fails", async () => {
  const calls: string[] = [];
  await warmFlow(async (cmd) => { calls.push(cmd); throw new Error("fail"); }, ["PROBE-1", "PROBE-2"], "INSTALL");
  assert.deepEqual(calls, ["PROBE-1", "PROBE-2", "INSTALL"]); // no retry after failed install
});

// ── recency → ddgs timelimit ─────────────────────────────────────────────────

test("timelimitFor maps every recency value to its ddgs letter code", () => {
  assert.equal(timelimitFor("day"), "d");
  assert.equal(timelimitFor("week"), "w");
  assert.equal(timelimitFor("month"), "m");
  assert.equal(timelimitFor("year"), "y");
});

test("timelimitFor returns null when no recency is given", () => {
  assert.equal(timelimitFor(undefined), null);
});

// ── buildDdgsTextCommand — the pure arg plan for `uvx ddgs text` ────────────

const BASE_ARGS = { query: "rust async", maxResults: 5, uvx: "/usr/bin/uvx", output: "/tmp/out.json" };

test("buildDdgsTextCommand pins the base flags: -q quoted, -m, -o", () => {
  const cmd = buildDdgsTextCommand(BASE_ARGS);
  assert.match(cmd, /^"\/usr\/bin\/uvx" ddgs text /);
  assert.match(cmd, /-q "rust async"/);
  assert.match(cmd, /-m 5/);
  assert.match(cmd, /-o "\/tmp\/out\.json"/);
});

test("buildDdgsTextCommand includes -t when a timelimit is given", () => {
  const cmd = buildDdgsTextCommand({ ...BASE_ARGS, timelimit: "w" });
  assert.match(cmd, /-t w/);
});

test("buildDdgsTextCommand omits -t entirely when timelimit is null", () => {
  const cmd = buildDdgsTextCommand({ ...BASE_ARGS, timelimit: null });
  assert.ok(!cmd.includes("-t"), `expected no -t flag, got: ${cmd}`);
});

test("buildDdgsTextCommand escapes double quotes in the query", () => {
  const cmd = buildDdgsTextCommand({ ...BASE_ARGS, query: 'say "hello"' });
  assert.match(cmd, /-q "say \\"hello\\""/);
});

test("ddgs-uv: warmDdgs runs at most once per process and never rejects", async () => {
  const calls: string[] = [];
  const failFirst = async (cmd: string) => {
    calls.push(cmd);
    if (calls.length === 1) throw new Error("boom");
  };
  await warmDdgs(failFirst); // failure swallowed — must not reject
  const afterFirst = calls.length;
  assert.ok(afterFirst >= 1);
  await warmDdgs(failFirst); // second call is a no-op (guard)
  assert.equal(calls.length, afterFirst);
});
