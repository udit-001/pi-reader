// Tests for github-clone.ts — the clone orchestration and rendering seams.
// Network and git are never touched: exec is injected (fake runner records
// argv), and rendering runs on temp-dir fixtures. Cross-process sweep logic
// is exercised through its pure parse/validate helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureClone,
  expandPath,
  normalizeCloneConfig,
  parseRuntimeOwner,
  renderRepoView,
  validateRepoRef,
  type CloneExec,
} from "../fetch/github-clone.ts";

// ── Fake exec runner ─────────────────────────────────────────────────────────

interface Call {
  command: string;
  args: string[];
}

type Route = (command: string, args: string[]) => { stdout?: string; stderr?: string; code?: number } | undefined;

function fakeExec(route: Route): { exec: CloneExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: CloneExec = async (command, args) => {
    calls.push({ command, args });
    const r = route(command, args);
    return { stdout: r?.stdout ?? "", stderr: r?.stderr ?? "", code: r?.code ?? 0 };
  };
  return { exec, calls };
}

// gh present, repo 1 MB, clone succeeds.
const ghHappyPath: Route = (command, args) => {
  if (command === "gh" && args[0] === "--version") return { code: 0 };
  if (command === "gh" && args[0] === "api") return { stdout: "1024\n" };
  return undefined;
};

function tmpClonePath(): string {
  return mkdtempSync(join(tmpdir(), "piweb-clone-test-"));
}

const REPO = { owner: "udit-001", repo: "pi-web" };

// ── Ref validation ───────────────────────────────────────────────────────────

test("clone: validateRepoRef rejects injection-shaped refs", () => {
  assert.ok(validateRepoRef({ ...REPO, ref: "--upload-pack=x" }));
  assert.ok(validateRepoRef({ owner: "o--o", repo: "r" }));
  assert.ok(validateRepoRef({ owner: "has space", repo: "r" }));
  assert.ok(validateRepoRef({ owner: "o", repo: "." }));
  assert.ok(validateRepoRef({ owner: "o", repo: ".." }));
  assert.ok(validateRepoRef({ owner: "", repo: "r" }));
  assert.ok(validateRepoRef({ owner: "o", repo: "r", ref: "a\nb" }));
});

test("clone: validateRepoRef accepts normal owners, repos, refs", () => {
  assert.equal(validateRepoRef({ owner: "udit-001", repo: "pi-web", ref: "main" }), null);
  assert.equal(validateRepoRef({ owner: "a", repo: "my.repo_name-x", ref: "v1.0" }), null);
});

// ── Config normalization ─────────────────────────────────────────────────────

test("clone: expandPath expands ~ and $HOME", () => {
  assert.equal(expandPath("~/repos"), join(process.env.HOME ?? "", "repos"));
  assert.equal(expandPath("$HOME/repos"), join(process.env.HOME ?? "", "repos"));
  assert.equal(expandPath("/tmp/pi-github-repos"), "/tmp/pi-github-repos");
});

test("clone: normalizeCloneConfig applies defaults and tolerates junk", () => {
  const cfg = normalizeCloneConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxRepoSizeMB, 350);
  assert.equal(cfg.cloneTimeoutSeconds, 30);
  assert.equal(cfg.clonePath, "/tmp/pi-github-repos");

  const junk = normalizeCloneConfig({ maxRepoSizeMB: -5, cloneTimeoutSeconds: "x", enabled: "yes" });
  assert.equal(junk.enabled, true);
  assert.equal(junk.maxRepoSizeMB, 350);
  assert.equal(junk.cloneTimeoutSeconds, 30);

  const custom = normalizeCloneConfig({ enabled: false, maxRepoSizeMB: 100, clonePath: "~/r" });
  assert.equal(custom.enabled, false);
  assert.equal(custom.maxRepoSizeMB, 100);
  assert.equal(custom.clonePath, join(process.env.HOME ?? "", "r"));
});

// ── Clone orchestration ──────────────────────────────────────────────────────

test("clone: ensureClone clones via gh and reports the checkout", async () => {
  const clonePath = tmpClonePath();
  const { exec, calls } = fakeExec(ghHappyPath);
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "cloned");
  if (result.status !== "cloned") return;
  assert.equal(result.via, "gh");
  assert.ok(existsSync(result.localPath));
  const cloneCall = calls.find((c) => c.command === "gh" && c.args[0] === "repo");
  assert.ok(cloneCall, "expected a gh repo clone call");
  assert.ok(cloneCall.args.includes("--depth") && cloneCall.args.includes("1"));
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone pins the requested branch", async () => {
  const clonePath = tmpClonePath();
  const { exec, calls } = fakeExec(ghHappyPath);
  await ensureClone({ ...REPO, ref: "main" }, { exec, clonePath });
  const cloneCall = calls.find((c) => c.command === "gh" && c.args[0] === "repo")!;
  const branchAt = cloneCall.args.indexOf("--branch");
  assert.ok(branchAt >= 0 && cloneCall.args[branchAt + 1] === "main");
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone falls back to git when gh is missing", async () => {
  const clonePath = tmpClonePath();
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 1 };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "cloned");
  if (result.status !== "cloned") return;
  assert.equal(result.via, "git");
  const gitCall = calls.find((c) => c.command === "git");
  assert.ok(gitCall, "expected a git clone call");
  assert.ok(gitCall.args.some((a) => a.startsWith("https://github.com/")));
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone declines oversized repos without cloning", async () => {
  const clonePath = tmpClonePath();
  // 400_000 KB = ~390 MB, above the 350 MB default limit.
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && args[0] === "api") return { stdout: "400000\n" };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "too-large");
  if (result.status !== "too-large") return;
  assert.equal(Math.round(result.sizeMB), 391);
  assert.equal(result.limitMB, 350);
  assert.ok(!calls.some((c) => c.args.includes("clone")), "must not clone");
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone reports failed clones and cleans the destination", async () => {
  const clonePath = tmpClonePath();
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && args[0] === "api") return { stdout: "1024\n" };
    if (command === "gh" && args[0] === "repo") return { code: 128, stderr: "fatal: repository not found" };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.match(result.reason, /repository not found/);
  assert.ok(!calls.some((c) => c.command === "git"), "no git retry after a gh clone that ran");
  // Destination removed: whatever dirs exist under the runtime are not the checkout.
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone dedupes concurrent clones of the same ref", async () => {
  const clonePath = tmpClonePath();
  let cloneCalls = 0;
  const { exec } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "repo") cloneCalls++;
    return ghHappyPath(command, args);
  });
  const [a, b] = await Promise.all([
    ensureClone(REPO, { exec, clonePath }),
    ensureClone(REPO, { exec, clonePath }),
  ]);
  assert.equal(a.status, "cloned");
  assert.equal(b.status, "cloned");
  if (a.status === "cloned" && b.status === "cloned") assert.equal(a.localPath, b.localPath);
  assert.equal(cloneCalls, 1);
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone reuses an existing checkout on a second call", async () => {
  const clonePath = tmpClonePath();
  let ghCalls = 0;
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh") ghCalls++;
    return ghHappyPath(command, args);
  });
  const first = await ensureClone(REPO, { exec, clonePath });
  const second = await ensureClone(REPO, { exec, clonePath });
  assert.equal(first.status, "cloned");
  assert.equal(second.status, "cloned");
  if (first.status === "cloned" && second.status === "cloned") assert.equal(first.localPath, second.localPath);
  assert.equal(calls.filter((c) => c.args.includes("clone")).length, 1);
  assert.equal(ghCalls, 3); // version, size, clone x1 (dedupe skips the rest)
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone reports invalid refs without running anything", async () => {
  const { exec, calls } = fakeExec(ghHappyPath);
  const result = await ensureClone({ owner: "bad owner", repo: "r" }, { exec });
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 0);
});

// ── Runtime owner file (stale-sweep helpers) ─────────────────────────────────

test("clone: parseRuntimeOwner validates strictly", () => {
  const ok = parseRuntimeOwner(JSON.stringify({ version: 1, pid: 123, platform: "linux" }));
  assert.ok(ok);
  assert.equal(ok?.pid, 123);
  assert.equal(parseRuntimeOwner("not json"), null);
  assert.equal(parseRuntimeOwner(JSON.stringify({ version: 2, pid: 123, platform: "linux" })), null);
  assert.equal(parseRuntimeOwner(JSON.stringify({ version: 1, pid: 0, platform: "linux" })), null);
  assert.equal(parseRuntimeOwner(JSON.stringify({ version: 1, pid: 123 })), null);
});

// ── Rendering ────────────────────────────────────────────────────────────────

function makeRepoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "piweb-render-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "README.md"), "hello readme");
  writeFileSync(join(root, "src", "b.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "docs", "guide.md"), "guide");
  writeFileSync(join(root, "node_modules", "x.js"), "junk");
  writeFileSync(join(root, ".git", "config"), "[core]");
  return root;
}

test("clone: renderRepoView renders structure + readme, skipping noise", () => {
  const root = makeRepoFixture();
  const content = renderRepoView(root, { type: "root" });
  assert.match(content, /Repository cloned to:/);
  assert.match(content, /## Structure/);
  assert.match(content, /src\/b\.ts/);
  assert.match(content, /docs\//);
  assert.match(content, /hello readme/);
  assert.ok(!content.includes("node_modules/x.js"));
  assert.ok(!content.includes("[core]"));
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView caps the tree at 200 entries", () => {
  const root = mkdtempSync(join(tmpdir(), "piweb-render-test-"));
  for (let i = 0; i < 250; i++) writeFileSync(join(root, `f${i}.txt`), "x");
  const content = renderRepoView(root, { type: "root" });
  assert.match(content, /truncated at 200 entries/);
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView lists a subdirectory with sizes", () => {
  const root = makeRepoFixture();
  const content = renderRepoView(root, { type: "tree", path: "src" });
  assert.match(content, /## src/);
  assert.match(content, /b\.ts/);
  assert.match(content, /B\)/);
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView falls back to the root view for a missing path", () => {
  const root = makeRepoFixture();
  const content = renderRepoView(root, { type: "tree", path: "nope" });
  assert.match(content, /not found in clone/);
  assert.match(content, /## Structure/);
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView contains path traversal", () => {
  const root = makeRepoFixture();
  const outside = tmpdir();
  const content = renderRepoView(root, { type: "tree", path: "../.." });
  assert.match(content, /not found in clone/);
  assert.ok(!content.includes(outside), "must not list directories outside the checkout");
  rmSync(root, { recursive: true, force: true });
});
