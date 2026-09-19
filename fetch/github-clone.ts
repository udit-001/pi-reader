// github-clone.ts — deep module: a local, exploreable checkout of a GitHub repo.
//
// Ported from pi-web-access (github-extract.ts / github-api.ts) and reshaped
// for pi-reader's handler architecture. The seam:
//
//   ensureClone({owner, repo, ref?}) -> {cloned, localPath, via}
//                                     | {too-large, sizeMB, limitMB}
//                                     | {failed, reason}
//                                     | {disabled}
//   renderRepoView(localPath, {root|tree, path?}) -> content
//
// Everything else — gh→git transport choice, repo size gate, cross-process
// runtime cache with owner files and stale sweeping, timeout kill discipline,
// traversal guards, tree caps — is implementation. `exec` and `clonePath` are
// injectable so tests never touch the network or git.
//
// Clone destinations live under `<clonePath>/runtime-<mkdtemp>/<sha256>`:
// /tmp by default (survives the session, dies with reboot, no cleanup logic
// of its own), deliberately outside the LRU-evicted pi-reader cache root — a
// checkout deleted mid-session under the agent's `read` is worse than disk.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath, sep as pathSep } from "node:path";
import { readFile, opendir, rm } from "node:fs/promises";
import { loadConfig } from "../config.ts";

// ── Public interface ─────────────────────────────────────────────────────────

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export type CloneResult =
  | { status: "cloned"; localPath: string; via: "gh" | "git" | "cache" }
  | { status: "too-large"; sizeMB: number; limitMB: number }
  | { status: "failed"; reason: string }
  | { status: "disabled" };

export interface CloneConfig {
  enabled: boolean;
  maxRepoSizeMB: number;
  cloneTimeoutSeconds: number;
  clonePath: string;
}

/** Injectable runner. The default impl spawns hardened, detached process groups. */
export type CloneExec = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export interface CloneOptions {
  signal?: AbortSignal;
  /** Test seam: replaces the real subprocess runner. */
  exec?: CloneExec;
  /** Test seam: overrides githubClone.clonePath from the config file. */
  clonePath?: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_REF_LEN = 1024;

/** Pure validation seam: error message, or null when the ref is safe to clone. */
export function validateRepoRef(ref: RepoRef): string | null {
  if (!OWNER_RE.test(ref.owner) || ref.owner.includes("--")) return `invalid owner: ${JSON.stringify(ref.owner)}`;
  if (!REPO_RE.test(ref.repo) || ref.repo === "." || ref.repo === "..") {
    return `invalid repo: ${JSON.stringify(ref.repo)}`;
  }
  if (ref.ref !== undefined) {
    if (ref.ref.length === 0 || ref.ref.length > MAX_REF_LEN) return `invalid ref: ${JSON.stringify(ref.ref)}`;
    if (/[\0-\x1f\x7f]/.test(ref.ref)) return `invalid ref: control characters`;
    // A ref lands in its own argv slot; a leading "-" would be read as a flag.
    if (ref.ref.startsWith("-")) return `invalid ref: must not start with "-"`;
  }
  return null;
}

const CLONE_DEFAULTS: CloneConfig = {
  enabled: true,
  maxRepoSizeMB: 350,
  cloneTimeoutSeconds: 30,
  clonePath: "/tmp/pi-github-repos",
};

/** Pure config seam: tolerant merge of the file's githubClone section over defaults. */
export function normalizeCloneConfig(raw: unknown): CloneConfig {
  const section = (raw ?? {}) as Record<string, unknown>;
  const positive = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    enabled: typeof section.enabled === "boolean" ? section.enabled : CLONE_DEFAULTS.enabled,
    maxRepoSizeMB: positive(section.maxRepoSizeMB, CLONE_DEFAULTS.maxRepoSizeMB),
    cloneTimeoutSeconds: positive(section.cloneTimeoutSeconds, CLONE_DEFAULTS.cloneTimeoutSeconds),
    clonePath: typeof section.clonePath === "string" && section.clonePath.trim()
      ? expandPath(section.clonePath.trim())
      : CLONE_DEFAULTS.clonePath,
  };
}

function loadCloneConfig(): CloneConfig {
  return normalizeCloneConfig(loadConfig()?.githubClone);
}

/** Expand `~` and `$VAR` at the start of a configured path. Pure; exported for tests. */
export function expandPath(value: string): string {
  let expanded = value;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = expanded.replace(/^~/, process.env.HOME ?? homedir());
  }
  expanded = expanded.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (match, varName: string) => process.env[varName] ?? match);
  return expanded;
}

// ── Clone orchestration ──────────────────────────────────────────────────────

// Keyed by `<runtimeRoot>|owner/repo@ref`: dedupes concurrent callers and
// reuses successful checkouts for the life of the process. Failed clones are
// dropped so a retry can actually retry.
const inflight = new Map<string, Promise<CloneResult>>();

export async function ensureClone(req: RepoRef, opts: CloneOptions = {}): Promise<CloneResult> {
  const invalid = validateRepoRef(req);
  if (invalid) return { status: "failed", reason: invalid };

  const cfg = {
    ...loadCloneConfig(),
    ...(opts.clonePath ? { clonePath: opts.clonePath } : {}),
  };
  if (!cfg.enabled) return { status: "disabled" };

  const runtimeRoot = resolveRuntimeRoot(cfg.clonePath);
  if (!runtimeRoot) return { status: "failed", reason: "could not create the clone runtime directory" };

  const key = `${runtimeRoot}|${req.owner}/${req.repo}@${req.ref ?? ""}`;
  const running = inflight.get(key);
  if (running) return running;

  const destination = join(runtimeRoot, digestOf(req));
  const promise = runClone(req, cfg, destination, key, opts);
  inflight.set(key, promise);
  return promise;
}

function digestOf(req: RepoRef): string {
  return createHash("sha256").update(JSON.stringify([req.owner, req.repo, req.ref ?? null])).digest("hex");
}

async function runClone(
  req: RepoRef,
  cfg: CloneConfig,
  destination: string,
  key: string,
  opts: CloneOptions,
): Promise<CloneResult> {
  const runner = opts.exec ?? defaultExec;
  const timeoutMs = cfg.cloneTimeoutSeconds * 1000;

  const hasGh = await ghAvailable(runner);

  // Size gate (gh only): refuse to clone repos over the budget, so the caller
  // can degrade to the API view. gh absent → no size knowledge → attempt.
  if (hasGh) {
    const sizeKb = await repoSizeKb(runner, req, timeoutMs, opts.signal);
    if (sizeKb !== null && sizeKb / 1024 > cfg.maxRepoSizeMB) {
      return { status: "too-large", sizeMB: sizeKb / 1024, limitMB: cfg.maxRepoSizeMB };
    }
  }

  // A leftover from a lost in-flight map (module reload) is still a valid
  // checkout of the same ref — reuse it.
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    return { status: "cloned", localPath: destination, via: "cache" };
  }
  rmSync(destination, { recursive: true, force: true });
  // git clone accepts an existing empty dir; creating it here also gives the
  // fake runner (tests) a real destination.
  mkdirSync(destination, { recursive: true, mode: 0o700 });

  const cloneArgs = hasGh
    ? ["repo", "clone", `${req.owner}/${req.repo}`, destination, "--", "--depth", "1", "--single-branch",
       ...(req.ref ? ["--branch", req.ref] : [])]
    : ["clone", "--depth", "1", "--single-branch",
       ...(req.ref ? ["--branch", req.ref] : []),
       `https://github.com/${req.owner}/${req.repo}.git`, destination];

  const cmd = hasGh ? "gh" : "git";
  const r = await runner(cmd, cloneArgs, { timeoutMs, signal: opts.signal });
  if (r.code !== 0) {
    rmSync(destination, { recursive: true, force: true });
    inflight.delete(key);
    return { status: "failed", reason: r.stderr.trim().slice(0, 300) || `${cmd} clone exited ${r.code}` };
  }
  return { status: "cloned", localPath: destination, via: hasGh ? "gh" : "git" };
}

async function ghAvailable(runner: CloneExec): Promise<boolean> {
  const r = await runner("gh", ["--version"], { timeoutMs: 5000 });
  return r.code === 0;
}

async function repoSizeKb(
  runner: CloneExec,
  req: RepoRef,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const r = await runner("gh", ["api", `repos/${req.owner}/${req.repo}`, "--jq", ".size"], { timeoutMs, signal });
  if (r.code !== 0) return null;
  const kb = parseInt(r.stdout.trim(), 10);
  return Number.isNaN(kb) ? null : kb;
}

// ── Default runner: hardened spawn with process-group kill ───────────────────

const KILL_GRACE_MS = 3000;
const OUTPUT_CAP = 2 * 1024 * 1024;

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    killer.unref();
    return;
  }
  // Clones run in their own process group so git credential helpers cannot
  // survive a timeout and keep reading the host TTY.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  forceKill.unref();
}

const defaultExec: CloneExec = (command, args, opts) =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GH_PROMPT_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d;
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d;
    });
    const timer = setTimeout(() => terminateProcessTree(child), opts.timeoutMs);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      terminateProcessTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.once("error", () => {
      // spawn failure (command missing): code -1 reads as "unavailable"
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1 });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });

// ── Runtime root + stale sweep ───────────────────────────────────────────────
// Each pi process clones into its own `runtime-XXXX` dir under the clone path.
// `.owner.json` records pid + platform (+ bootId and /proc start time on
// Linux, defending against PID reuse); a one-shot background sweep deletes
// runtimes whose owner is provably dead.

interface RuntimeOwner {
  version: 1;
  pid: number;
  platform: string;
  bootId?: string;
  startTime?: string;
}

const OWNER_FILENAME = ".owner.json";
const MAX_OWNER_BYTES = 1024;

/** Pure parse seam for the owner file. Returns null on anything unexpected. */
export function parseRuntimeOwner(text: string): RuntimeOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (typeof r.pid !== "number" || !Number.isSafeInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.platform !== "string" || r.platform.length === 0 || r.platform.length > 32) return null;
  const owner: RuntimeOwner = { version: 1, pid: r.pid, platform: r.platform };
  if (r.bootId !== undefined) {
    if (typeof r.bootId !== "string" || r.bootId.length === 0 || r.bootId.length > 256) return null;
    owner.bootId = r.bootId;
  }
  if (r.startTime !== undefined) {
    if (typeof r.startTime !== "string" || !/^\d+$/.test(r.startTime)) return null;
    owner.startTime = r.startTime;
  }
  return owner;
}

function readBootId(): string | null {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return bootId || null;
  } catch {
    return null;
  }
}

/** /proc start time (field 22) for a pid, or null when unreadable. */
function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

function processNonexistenceProven(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "ESRCH");
  }
}

function ownerIsDead(owner: RuntimeOwner): boolean {
  if (owner.platform !== process.platform) return false; // can't judge → preserve
  if (process.platform !== "linux") return processNonexistenceProven(owner.pid);
  // Linux PIDs get reused: require bootId + start time before declaring death.
  if (!owner.bootId || !owner.startTime) return false;
  const bootId = readBootId();
  if (!bootId || bootId !== owner.bootId) return false;
  const startTime = procStartTime(owner.pid);
  if (startTime === null) return false; // unreadable → preserve
  return startTime !== owner.startTime;
}

function writeOwnerFile(runtimePath: string): void {
  const owner: RuntimeOwner = {
    version: 1,
    pid: process.pid,
    platform: process.platform,
  };
  if (process.platform === "linux") {
    const bootId = readBootId();
    const startTime = procStartTime(process.pid);
    if (bootId) owner.bootId = bootId;
    if (startTime) owner.startTime = startTime;
  }
  writeFileSync(join(runtimePath, OWNER_FILENAME), JSON.stringify(owner), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function sweepStaleRuntimes(parentPath: string): Promise<void> {
  const bootId = process.platform === "linux" ? readBootId() : null;
  let dir;
  try {
    dir = await opendir(parentPath);
  } catch {
    return;
  }
  for await (const entry of dir) {
    if (!entry.name.startsWith("runtime-")) continue;
    try {
      const runtimePath = join(parentPath, entry.name);
      const st = lstatSync(runtimePath);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const ownerFile = join(runtimePath, OWNER_FILENAME);
      const ownerStat = lstatSync(ownerFile);
      if (!ownerStat.isFile() || ownerStat.size > MAX_OWNER_BYTES) continue;
      const owner = parseRuntimeOwner(await readFile(ownerFile, "utf8"));
      if (!owner || !ownerIsDead(owner)) continue;
      // Guarded delete: only a real directory named runtime-* directly under parent.
      const real = realpathSync(runtimePath);
      if (dirname(real) !== parentPath || basename(real) !== entry.name) continue;
      await rm(real, { recursive: true, force: true });
    } catch {
      // One unreadable runtime must not stop the sweep.
    }
  }
}

const sweptParents = new Set<string>();
const runtimeRoots = new Map<string, string>();

/** Create (once per clonePath) the process's runtime dir. Returns its realpath. */
function resolveRuntimeRoot(clonePath: string): string | null {
  const cached = runtimeRoots.get(clonePath);
  if (cached) return cached;
  try {
    mkdirSync(clonePath, { recursive: true });
    const parent = realpathSync(clonePath);
    if (!sweptParents.has(parent)) {
      sweptParents.add(parent);
      void sweepStaleRuntimes(parent).catch(() => {});
    }
    const runtimePath = mkdtempSync(join(parent, "runtime-"));
    chmodSync(runtimePath, 0o700);
    const root = realpathSync(runtimePath);
    if (dirname(root) !== parent) {
      rmSync(runtimePath, { recursive: true, force: true });
      return null;
    }
    writeOwnerFile(root);
    runtimeRoots.set(clonePath, root);
    return root;
  } catch {
    return null;
  }
}

// ── Rendering: describe the checkout for the agent ───────────────────────────

const MAX_TREE_ENTRIES = 200;
const MAX_README_CHARS = 8192;
const README_CANDIDATES = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
const NOISE_DIRS = new Set([
  "node_modules", "vendor", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "target", ".gradle", ".idea", ".vscode",
]);

const EXPLORE_HINT = "Use read and bash at the path above to explore further.";

/** Path guard: resolve inside the checkout, rejecting traversal and symlinks out. */
function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
  const root = resolvePath(rootPath);
  const candidate = resolvePath(root, relativePath);
  const rootPrefix = root.endsWith(pathSep) ? root : root + pathSep;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) return null;
  if (!existsSync(candidate)) return candidate;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (realCandidate === realRoot) return candidate;
    const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
    return realCandidate.startsWith(realRootPrefix) ? candidate : null;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildTree(rootPath: string): string {
  const entries: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;
      const relPath = rel ? `${rel}/${item}` : item;
      const safe = resolveWithinRepo(rootPath, relPath);
      if (!safe) continue;
      let st;
      try {
        st = statSync(safe);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${relPath}/  [skipped]`);
          continue;
        }
        entries.push(`${relPath}/`);
        walk(safe, relPath);
      } else {
        entries.push(relPath);
      }
    }
  };
  walk(rootPath, "");
  if (entries.length >= MAX_TREE_ENTRIES) entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
  return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
  const target = resolveWithinRepo(rootPath, subPath);
  if (!target) return "(path escapes the checkout)";
  let items: string[];
  try {
    items = readdirSync(target).sort();
  } catch {
    return "(directory not readable)";
  }
  const lines: string[] = [];
  for (const item of items) {
    if (item === ".git") continue;
    const safe = resolveWithinRepo(rootPath, subPath ? `${subPath}/${item}` : item);
    if (!safe) {
      lines.push(`  ${item}  (outside checkout)`);
      continue;
    }
    try {
      const st = statSync(safe);
      lines.push(st.isDirectory() ? `  ${item}/` : `  ${item}  (${formatSize(st.size)})`);
    } catch {
      lines.push(`  ${item}  (unreadable)`);
    }
  }
  return lines.join("\n");
}

function readReadme(localPath: string): string | null {
  for (const name of README_CANDIDATES) {
    const p = join(localPath, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8");
      return content.length > MAX_README_CHARS
        ? `${content.slice(0, MAX_README_CHARS)}\n\n[README truncated at 8K chars]`
        : content;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Render a checkout view for the agent: repository root (structure + README)
 * or a subdirectory listing. `path` is repo-relative and traversal-guarded;
 * a missing or escaping path degrades to the root view, never outside reads.
 */
export function renderRepoView(
  localPath: string,
  view: { type: "root" | "tree"; path?: string },
): string {
  if (view.type === "tree" && view.path) {
    const target = resolveWithinRepo(localPath, view.path);
    if (target && existsSync(target) && statSync(target).isDirectory()) {
      return [`## ${view.path}`, buildDirListing(localPath, view.path), "", EXPLORE_HINT].join("\n");
    }
    return [
      `Path \`${view.path}\` not found in clone. Showing repository root instead.`,
      "",
      "## Structure",
      buildTree(localPath),
      "",
      EXPLORE_HINT,
    ].join("\n");
  }
  const parts = [`Repository cloned to: ${localPath}`, "", "## Structure", buildTree(localPath), ""];
  const readme = readReadme(localPath);
  if (readme) parts.push("## README.md", readme, "");
  parts.push(EXPLORE_HINT);
  return parts.join("\n");
}
