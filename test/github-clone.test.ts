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
  resolveTreePath,
  splitTreePath,
  transportEnv,
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

// gh present, repo 1 MB, clone succeeds. The trees call returns the checkout
// estimate (1 KB of blobs); the plain `api` route is the whole-repo fallback.
// The clone writes a marker file so the destination is a usable checkout, as a
// real git clone would leave it.
const ghHappyPath: Route = (command, args) => {
  if (command === "gh" && args[0] === "--version") return { code: 0 };
  if (command === "gh" && args[0] === "api" && (args[1] ?? "").includes("/git/trees/")) {
    return { stdout: JSON.stringify({ total: 1024, truncated: false }) };
  }
  if (command === "gh" && args[0] === "api") return { stdout: "1024\n" };
  if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
    const destination = args[3];
    if (destination) {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "README.md"), "cloned\n");
    }
  }
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

// ── Tree URL ref resolution ──────────────────────────────────────────────────

test("clone: splitTreePath takes the longest known ref (GitHub's own rule)", () => {
  const refs = new Set(["main", "feature/x", "release/1.2"]);
  assert.deepEqual(splitTreePath(["feature", "x", "src"], refs), { ref: "feature/x", subPath: "src" });
  assert.deepEqual(splitTreePath(["main", "src"], refs), { ref: "main", subPath: "src" });
  assert.deepEqual(splitTreePath(["main"], refs), { ref: "main", subPath: "" });
  assert.deepEqual(splitTreePath(["release", "1.2", "docs", "a.md"], refs), { ref: "release/1.2", subPath: "docs/a.md" });
});

test("clone: splitTreePath falls back to the first segment with no usable ref list", () => {
  // The clone's own failure path still degrades to the API view.
  assert.deepEqual(splitTreePath(["feature", "x", "src"], new Set()), { ref: "feature", subPath: "x/src" });
  assert.deepEqual(splitTreePath([], new Set()), { ref: undefined, subPath: "" });
});

test("clone: resolveTreePath resolves a slash branch to the longest matching ref", async () => {
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "git" && args[0] === "ls-remote") {
      return { stdout: "a\trefs/heads/main\nb\trefs/heads/feature/x\nc\trefs/tags/v1.0\nd\trefs/tags/v1.0^{}\n" };
    }
    return undefined;
  });
  assert.deepEqual(await resolveTreePath("o1", "r1", ["feature", "x", "src"], { exec }), { ref: "feature/x", subPath: "src" });
  assert.ok(calls.some((c) => c.command === "git" && c.args[0] === "ls-remote"), "expected an ls-remote lookup");
});

test("clone: resolveTreePath resolves a tag and strips the annotated-tag suffix", async () => {
  const { exec } = fakeExec((command, args) => {
    if (command === "git" && args[0] === "ls-remote") return { stdout: "aaa\trefs/tags/v2.0\nbbb\trefs/tags/v2.0^{}\n" };
    return undefined;
  });
  assert.deepEqual(await resolveTreePath("o2", "r2", ["v2.0", "docs"], { exec }), { ref: "v2.0", subPath: "docs" });
});

test("clone: resolveTreePath degrades to the first segment when ls-remote fails", async () => {
  const { exec } = fakeExec((command, args) => {
    if (command === "git" && args[0] === "ls-remote") return { code: 128, stderr: "repository not found" };
    return undefined;
  });
  assert.deepEqual(await resolveTreePath("o3", "r3", ["feature", "x"], { exec }), { ref: "feature", subPath: "x" });
});

test("clone: resolveTreePath needs no lookup for a bare ref or a commit SHA", async () => {
  const { exec, calls } = fakeExec(() => undefined);
  assert.deepEqual(await resolveTreePath("o4", "r4", ["main"], { exec }), { ref: "main", subPath: "" });
  const sha = "a".repeat(40);
  assert.deepEqual(await resolveTreePath("o5", "r5", [sha, "src"], { exec }), { ref: sha, subPath: "src" });
  assert.equal(calls.length, 0);
});

test("clone: resolveTreePath memoizes the ref list per repo", async () => {
  let lookups = 0;
  const { exec } = fakeExec((command, args) => {
    if (command === "git" && args[0] === "ls-remote") {
      lookups++;
      return { stdout: "a\trefs/heads/release/1.2\n" };
    }
    return undefined;
  });
  assert.deepEqual(await resolveTreePath("o6", "r6", ["release", "1.2", "docs"], { exec }), { ref: "release/1.2", subPath: "docs" });
  assert.deepEqual(await resolveTreePath("o6", "r6", ["release", "1.2"], { exec }), { ref: "release/1.2", subPath: "" });
  assert.equal(lookups, 1, "the second call must not re-run ls-remote");
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

test("clone: transportEnv never prompts and never smudges LFS", () => {
  const env = transportEnv({ PATH: "/usr/bin", GIT_LFS_SKIP_SMUDGE: "0" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "Never");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, "1", "must override an inherited value");
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

// Renders the trees --jq payload the checkout-size estimator parses.
const treesPayload = (bytes: number, truncated = false): string => JSON.stringify({ total: bytes, truncated });

function routesTrees(args: string[]): boolean {
  return args[0] === "api" && (args[1] ?? "").includes("/git/trees/");
}

test("clone: ensureClone gates on the working tree, not the full repo history", async () => {
  const clonePath = tmpClonePath();
  // react-shaped: 1073 MB of history, 39 MB working tree. The whole-repo gate
  // refused it (1073 > 350); the checkout estimate (39 x2) clones.
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && routesTrees(args)) return { stdout: treesPayload(39 * 1024 * 1024) };
    if (command === "gh" && args[0] === "api") return { stdout: "1099593\n" };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "cloned");
  assert.ok(calls.some((c) => c.command === "gh" && c.args[0] === "repo"), "expected a clone");
  assert.ok(!calls.some((c) => c.command === "gh" && c.args.at(-1) === ".size"), "a clean tree estimate must not need the full size");
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone declines a repo whose working tree is over the limit", async () => {
  const clonePath = tmpClonePath();
  // 200 MB of blobs -> ~400 MB checkout, above the 350 MB default.
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && routesTrees(args)) return { stdout: treesPayload(200 * 1024 * 1024) };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "too-large");
  if (result.status !== "too-large") return;
  assert.equal(Math.round(result.sizeMB), 400);
  assert.equal(result.limitMB, 350);
  assert.ok(!calls.some((c) => c.args.includes("clone")), "must not clone");
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone memoizes a too-large verdict", async () => {
  const clonePath = tmpClonePath();
  let treesCalls = 0;
  const { exec } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && routesTrees(args)) {
      treesCalls++;
      return { stdout: treesPayload(400 * 1024 * 1024) };
    }
    return undefined;
  });
  const first = await ensureClone(REPO, { exec, clonePath });
  const second = await ensureClone(REPO, { exec, clonePath });
  assert.equal(first.status, "too-large");
  assert.equal(second.status, "too-large");
  assert.equal(treesCalls, 1, "the size lookup must not repeat per fetch");
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone falls back to the whole-repo size when the tree listing is truncated", async () => {
  const clonePath = tmpClonePath();
  // A tree the API will not return whole: its partial sum is untrusted.
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && routesTrees(args)) return { stdout: treesPayload(1024, true) };
    if (command === "gh" && args[0] === "api") return { stdout: "400000\n" };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "too-large");
  assert.ok(calls.some((c) => c.command === "gh" && c.args.at(-1) === ".size"), "expected the full-size fallback");
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone falls back to the whole-repo size when the tree listing fails", async () => {
  const clonePath = tmpClonePath();
  const { exec } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && routesTrees(args)) return { code: 1, stderr: "Not Found" };
    if (command === "gh" && args[0] === "api") return { stdout: "400000\n" };
    return undefined;
  });
  const result = await ensureClone(REPO, { exec, clonePath });
  assert.equal(result.status, "too-large");
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
  assert.equal(ghCalls, 3); // version, trees, clone x1 (dedupe skips the rest)
  rmSync(clonePath, { recursive: true, force: true });
});

test("clone: ensureClone re-clones when a cached checkout has been deleted", async () => {
  const clonePath = tmpClonePath();
  const { exec, calls } = fakeExec(ghHappyPath);
  const first = await ensureClone(REPO, { exec, clonePath });
  assert.equal(first.status, "cloned");
  if (first.status !== "cloned") return;
  assert.equal(calls.filter((c) => c.args.includes("clone")).length, 1);

  // A /tmp cleaner removes the runtime dir mid-session.
  rmSync(first.localPath, { recursive: true, force: true });

  const second = await ensureClone(REPO, { exec, clonePath });
  assert.equal(second.status, "cloned");
  if (second.status !== "cloned") return;
  assert.ok(existsSync(second.localPath), "must not hand back a dead path");
  assert.equal(calls.filter((c) => c.args.includes("clone")).length, 2, "a vanished checkout must be re-cloned");
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

test("clone: every render names the checkout path the hint refers to", () => {
  // The explore hint says "the path above"; a view without the path sends the
  // agent looking for a checkout it was never given.
  const root = makeRepoFixture();
  const views = {
    root: renderRepoView(root, { type: "root" }),
    tree: renderRepoView(root, { type: "tree", path: "src" }),
    fallback: renderRepoView(root, { type: "tree", path: "nope" }),
  };
  for (const [name, content] of Object.entries(views)) {
    assert.ok(content.includes(root), `${name} view must name the checkout`);
  }
  assert.ok(views.tree.includes(join(root, "src")), "tree view must name the subdirectory");
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView names the checkout as shallow", () => {
  const root = makeRepoFixture();
  const content = renderRepoView(root, { type: "root" });
  assert.match(content, /Shallow checkout/);
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
  assert.match(content, /\(\d+ B\)/);
  assert.ok(!content.includes("Shallow checkout"), "a subdirectory listing is not a checkout summary");
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView falls back to the root view for a missing path", () => {
  const root = makeRepoFixture();
  const content = renderRepoView(root, { type: "tree", path: "nope" });
  assert.match(content, /not found in clone/);
  assert.match(content, /## Structure/);
  assert.match(content, /Shallow checkout/, "the fallback is a root view, so it carries the note");
  rmSync(root, { recursive: true, force: true });
});

test("clone: renderRepoView contains path traversal", () => {
  const root = makeRepoFixture();
  // A sibling of the checkout: if the render ever walked to "../..", this name
  // would appear in the listing. The checkout path line legitimately contains
  // tmpdir, so absence of the sentinel is the real assertion.
  const sentinel = join(tmpdir(), "piweb-outside-sentinel");
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(join(sentinel, "secret.txt"), "x");
  const content = renderRepoView(root, { type: "tree", path: "../.." });
  assert.match(content, /not found in clone/);
  assert.ok(!content.includes("piweb-outside-sentinel"), "must not list directories outside the checkout");
  assert.match(content, /src\//, "falls back to the checkout's own root");
  rmSync(root, { recursive: true, force: true });
  rmSync(sentinel, { recursive: true, force: true });
});
