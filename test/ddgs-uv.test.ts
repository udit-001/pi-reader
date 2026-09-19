// Tests for the ddgs-uv module — uvx availability detection and path resolution.
// No network calls; tests the detection logic only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUvx, uvxInstallPath, uvInstallCommand, probeCommands, warmFlow, warmDdgs, timelimitFor, buildDdgsArgs } from "../search/ddgs-uv.ts";
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

// ── buildDdgsArgs — the pure argv plan for `uvx ddgs text` ──────────────

const BASE_ARGS = { subcommand: "text" as const, query: "rust async", maxResults: 5, uvx: "/usr/bin/uvx", output: "/tmp/out.json" };

/** Locate the argv slot following a flag. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test("buildDdgsArgs pins the base flags: -q, -m, -o", () => {
  const args = buildDdgsArgs(BASE_ARGS);
  assert.equal(args[0], "/usr/bin/uvx");
  assert.deepEqual(args.slice(1, 3), ["ddgs", "text"]);
  assert.equal(flagValue(args, "-q"), "rust async");
  assert.equal(flagValue(args, "-m"), "5");
  assert.equal(flagValue(args, "-o"), "/tmp/out.json");
});

test("buildDdgsArgs includes -t when a timelimit is given", () => {
  const args = buildDdgsArgs({ ...BASE_ARGS, timelimit: "w" });
  assert.deepEqual([flagValue(args, "-t")], ["w"]);
});

test("buildDdgsArgs omits -t entirely when timelimit is null", () => {
  const args = buildDdgsArgs({ ...BASE_ARGS, timelimit: null });
  assert.ok(!args.includes("-t"), `expected no -t flag, got: ${args.join(" ")}`);
});

test("buildDdgsArgs omits -p when page is 1 or unset", () => {
  const unset = buildDdgsArgs(BASE_ARGS);
  const first = buildDdgsArgs({ ...BASE_ARGS, page: 1 });
  assert.ok(!unset.includes("-p"), `expected no -p flag, got: ${unset.join(" ")}`);
  assert.ok(!first.includes("-p"), `expected no -p flag, got: ${first.join(" ")}`);
});

test("buildDdgsArgs includes -p for pages beyond the first", () => {
  const args = buildDdgsArgs({ ...BASE_ARGS, page: 3 });
  assert.deepEqual([flagValue(args, "-p")], ["3"]);
});

test("buildDdgsArgs keeps the query as ONE argv slot — no shell quoting or escaping", () => {
  // Regression: the old builder embedded the query in a shell string, so $(...)
  // and backticks were command-substituted by /bin/sh (command injection).
  // The argv plan must carry the query verbatim; execFileSync never interprets it.
  const hostile = 'x"; $(touch /tmp/PI_AUDIT_POC); `id`; \\';
  const args = buildDdgsArgs({ ...BASE_ARGS, query: hostile });
  assert.deepEqual([flagValue(args, "-q")], [hostile]);
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
