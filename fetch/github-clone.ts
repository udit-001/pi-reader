// github-clone.ts — deep module: a local, exploreable checkout of a GitHub repo.
//
// Ported from pi-web-access (github-extract.ts / github-api.ts) and reshaped
// for pi-reader's handler architecture. The seam:
//
//   ensureClone({owner, repo, ref?}) -> {cloned, localPath, via, submodulesIncomplete?}
//                                     | {too-large, sizeMB, limitMB}
//                                     | {failed, reason}
//                                     | {disabled}
//   renderRepoView(localPath, {root|tree, path?}) -> content
//   resolveTreePath(owner, repo, segments) -> {ref, subPath}
//
// Everything else — gh→git transport choice, checkout-size gate, tree-URL ref
// resolution, best-effort submodule init, cross-process runtime cache with
// owner files and stale sweeping, timeout kill discipline, traversal guards,
// tree caps — is implementation.
// `exec` and `clonePath` are injectable so tests never touch the network or git.
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
  type Stats,
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
  | { status: "cloned"; localPath: string; via: "gh" | "git" | "cache"; submodulesIncomplete?: boolean }
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

// Two maps, two lifetimes. `inflight` dedupes concurrent callers and is cleared
// the moment a clone settles. `settled` memoizes a terminal verdict for the
// process — a checkout (re-validated on every read, because the disk is not
// ours to trust: a /tmp cleaner must not hand the agent a dead path) and a
// too-large refusal (stable, so the size lookup is not repeated per fetch).
const inflight = new Map<string, Promise<CloneResult>>();
const settled = new Map<string, CloneResult>();

/** A checkout is reusable only when the directory exists and is not empty — a
 *  failed clone can leave an empty destination, and a cleaner can remove a
 *  whole one. */
function isUsableCheckout(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

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
  const cached = settled.get(key);
  if (cached) {
    if (cached.status !== "cloned") return cached;
    // Spread, not a fresh object: a cache hit must keep the submodule flag.
    if (isUsableCheckout(cached.localPath)) return { ...cached, via: "cache" };
    settled.delete(key);
  }

  const destination = join(runtimeRoot, digestOf(req));
  const promise = runClone(req, cfg, destination, opts);
  inflight.set(key, promise);
  try {
    const result = await promise;
    if (result.status === "cloned" || result.status === "too-large") settled.set(key, result);
    return result;
  } finally {
    inflight.delete(key);
  }
}

function digestOf(req: RepoRef): string {
  return createHash("sha256").update(JSON.stringify([req.owner, req.repo, req.ref ?? null])).digest("hex");
}

async function runClone(
  req: RepoRef,
  cfg: CloneConfig,
  destination: string,
  opts: CloneOptions,
): Promise<CloneResult> {
  const runner = opts.exec ?? defaultExec;
  const timeoutMs = cfg.cloneTimeoutSeconds * 1000;

  const hasGh = await ghUsable(runner);

  // Size gate (gh only): refuse to clone repos over the budget, so the caller
  // can degrade to the API view. The estimate is the ref's WORKING TREE, not
  // the whole repo — `repo.size` counts every commit in history, so it refused
  // popular repos with tiny shallow clones (react: 1073 MB full, 73 MB clone).
  // gh absent → no size knowledge → attempt.
  if (hasGh) {
    const sizeMB = await checkoutSizeMB(runner, req, timeoutMs, opts.signal);
    if (sizeMB !== null && sizeMB > cfg.maxRepoSizeMB) {
      return { status: "too-large", sizeMB, limitMB: cfg.maxRepoSizeMB };
    }
  }

  // A leftover from a lost in-flight map (module reload) is still a valid
  // checkout of the same ref — reuse it, but still finish its submodules.
  if (isUsableCheckout(destination)) {
    const incomplete = await initSubmodules(runner, destination, timeoutMs, opts.signal);
    return clonedResult(destination, "cache", incomplete);
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
    return { status: "failed", reason: r.stderr.trim().slice(0, 300) || `${cmd} clone exited ${r.code}` };
  }
  const submodulesIncomplete = await initSubmodules(runner, destination, timeoutMs, opts.signal);
  return clonedResult(destination, hasGh ? "gh" : "git", submodulesIncomplete);
}

/** The `cloned` result, with the optional submodule flag built in one place. */
function clonedResult(localPath: string, via: "gh" | "git" | "cache", submodulesIncomplete: boolean): CloneResult {
  return {
    status: "cloned",
    localPath,
    via,
    ...(submodulesIncomplete ? { submodulesIncomplete: true } : {}),
  };
}

/** Best-effort submodule init: skipped when the repo declares none, and a
 *  failure leaves the directory empty rather than failing the checkout. Returns
 *  true when content is missing, so the caller can say so. */
async function initSubmodules(
  runner: CloneExec,
  destination: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!existsSync(join(destination, ".gitmodules"))) return false;
  const r = await runner("git", ["-C", destination, "submodule", "update", "--init", "--recursive", "--depth", "1"], {
    timeoutMs,
    signal,
  });
  return r.code !== 0;
}

/** gh is usable only when it can act: `gh --version` passes when logged out,
 *  but every API call and clone then fails — silently disabling both the size
 *  gate and the checkout. Probing auth sends a logged-out gh down the git path,
 *  where public repos still clone. */
async function ghUsable(runner: CloneExec): Promise<boolean> {
  const r = await runner("gh", ["auth", "status"], { timeoutMs: 5000 });
  return r.code === 0;
}

/** The whole-repo size in KB (every commit in history) — the conservative
 *  fallback when the working-tree estimate is unavailable. */
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

/** git stores the tree again as objects on top of the checked-out files, so
 *  the on-disk checkout is larger than the working tree it came from; 2× tracks
 *  it closely and errs conservative. */
const CHECKOUT_OVERHEAD = 2;

/** Working-tree bytes for the requested ref (sum of blob sizes), or null.
 *  `truncated` marks the sum as a partial lower bound — a tree the API will
 *  not return whole. */
async function treeSizeBytes(
  runner: CloneExec,
  req: RepoRef,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ bytes: number; truncated: boolean } | null> {
  const ref = encodeURIComponent(req.ref ?? "HEAD");
  const r = await runner(
    "gh",
    [
      "api",
      `repos/${req.owner}/${req.repo}/git/trees/${ref}?recursive=1`,
      "--jq",
      '{total: ([.tree[] | select(.type=="blob") | .size] | add // 0), truncated}',
    ],
    { timeoutMs, signal },
  );
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim()) as { total?: unknown; truncated?: unknown };
    if (typeof parsed.total !== "number" || !Number.isFinite(parsed.total)) return null;
    return { bytes: parsed.total, truncated: parsed.truncated === true };
  } catch {
    return null;
  }
}

/** The checkout's size in MB. A clean working-tree sum is what a `--depth 1`
 *  clone actually pulls; a truncated or unavailable listing falls back to the
 *  whole-repo size (today's conservative number), and null when neither is
 *  known. */
async function checkoutSizeMB(
  runner: CloneExec,
  req: RepoRef,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const tree = await treeSizeBytes(runner, req, timeoutMs, signal);
  if (tree && !tree.truncated) return (tree.bytes * CHECKOUT_OVERHEAD) / (1024 * 1024);
  const sizeKb = await repoSizeKb(runner, req, timeoutMs, signal);
  return sizeKb === null ? null : sizeKb / 1024;
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

/** The subprocess env for every transport call: never prompt, and never smudge
 *  LFS — a `--depth 1` clone would otherwise pull every LFS object in the tree,
 *  which the size gate cannot see. Pure; exported for tests. */
export function transportEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GH_PROMPT_DISABLED: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

const defaultExec: CloneExec = (command, args, opts) =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: transportEnv(),
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

// ── Tree URL ref resolution ──────────────────────────────────────────────────
// GitHub resolves `/owner/repo/tree/<a>/<b>/<c>` by taking the LONGEST ref that
// prefixes the path; the remainder is the subpath. Reading only the first
// segment breaks every branch name containing a slash — feature/x, release/1.2,
// dependabot/... — and the clone then fails to the API view. The ref list is
// one `git ls-remote` (refs only, no objects), memoized per repo for the
// process; when it is unavailable the splitter degrades to the first segment.

/** Pure; exported for tests. `segments` are the URL segments after "tree". */
export function splitTreePath(
  segments: string[],
  knownRefs: ReadonlySet<string>,
): { ref: string | undefined; subPath: string } {
  if (segments.length === 0) return { ref: undefined, subPath: "" };
  for (let end = segments.length; end >= 1; end--) {
    const candidate = segments.slice(0, end).join("/");
    if (knownRefs.has(candidate)) return { ref: candidate, subPath: segments.slice(end).join("/") };
  }
  return { ref: segments[0], subPath: segments.slice(1).join("/") };
}

const REF_LIST_TIMEOUT_MS = 15_000;

/** A full commit SHA is never a branch, so no ref list contains it and
 *  `--branch` cannot take it. Exported so the handler's clone guard shares one
 *  definition. */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Any commit-ish ref — git's short form (7) through the full id (40), case-
 *  insensitive because a URL may keep uppercase hex. A branch can also be
 *  all-hex, so this only *names* a clone failure; routing stays on the stricter
 *  FULL_SHA_RE, which is why a short all-hex branch still reaches a clone
 *  attempt (a full lowercase all-hex ref is indistinguishable from an id). */
export const SHA_LIKE_RE = /^[0-9a-f]{7,40}$/i;

/** Ref lists memoized per repo for the process: a slash-ref tree URL resolves
 *  on every fetch, and without this a cached checkout would still pay a network
 *  round-trip each time. */
const refSets = new Map<string, ReadonlySet<string>>();

/** refs/heads/* and refs/tags/* for the repo, or an empty set when unavailable. */
async function listRepoRefs(
  owner: string,
  repo: string,
  runner: CloneExec,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const memoKey = `${owner}/${repo}`;
  const memo = refSets.get(memoKey);
  if (memo) return memo;
  const refs = new Set<string>();
  const r = await runner(
    "git",
    ["ls-remote", "--heads", "--tags", `https://github.com/${owner}/${repo}.git`],
    { timeoutMs: REF_LIST_TIMEOUT_MS, signal },
  );
  if (r.code === 0) {
    for (const line of r.stdout.split("\n")) {
      const match = line.match(/^[0-9a-f]+\s+refs\/(?:heads|tags)\/(.+?)(?:\^\{\})?$/);
      if (match?.[1]) refs.add(match[1]);
    }
  }
  refSets.set(memoKey, refs);
  return refs;
}

/** Resolve a tree URL's ref + subpath. One segment is the ref outright; a
 *  subpath may extend the ref, so the repo's refs are consulted once. */
export async function resolveTreePath(
  owner: string,
  repo: string,
  segments: string[],
  opts: CloneOptions = {},
): Promise<{ ref: string | undefined; subPath: string }> {
  // Nothing to look up: a bare ref is the whole path, a commit SHA is never a
  // ref, and an unqueryable repo cannot answer.
  if (segments.length <= 1 || FULL_SHA_RE.test(segments[0] ?? "") || validateRepoRef({ owner, repo })) {
    return splitTreePath(segments, new Set());
  }
  const refs = await listRepoRefs(owner, repo, opts.exec ?? defaultExec, opts.signal);
  return splitTreePath(segments, refs);
}

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
/** Most-preferred first, matched case-insensitively against the listing so a
 *  variant spelling (`Readme.md`) still wins over a lower-preference name. */
const README_PATTERNS = [/^readme\.md$/i, /^readme\.markdown$/i, /^readme$/i, /^readme\.rst$/i, /^readme\.txt$/i];
const NOISE_DIRS = new Set([
  "node_modules", "vendor", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "target", ".gradle", ".idea", ".vscode",
]);

const EXPLORE_HINT = "Use read and bash at the path above to explore further.";
const FILE_HINT = "Use read at that path.";
const SHALLOW_NOTE = "Shallow checkout (one branch, depth 1): `git log`, `git blame`, and `git show` see only the tip.";

/** Every view opens with the checkout path: EXPLORE_HINT says "the path
 *  above", so a view without it sends the agent looking for nothing. */
function clonedTo(localPath: string): string {
  return `Repository cloned to: ${localPath}`;
}

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

/** statSync that returns undefined instead of throwing: a checkout is live, so
 *  an entry can vanish or become unreadable between listing and stat. The
 *  caller owns what to do about it. */
function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
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
      const st = safeStat(safe);
      if (!st) continue;
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
    const st = safeStat(safe);
    if (!st) {
      lines.push(`  ${item}  (unreadable)`);
      continue;
    }
    lines.push(st.isDirectory() ? `  ${item}/` : `  ${item}  (${formatSize(st.size)})`);
  }
  return lines.join("\n");
}

/** The repo's README, matched case-insensitively over the directory listing so
 *  `Readme.md` and `README.markdown` are not missed, and returned with the name
 *  it actually has. A name that turns out to be a directory falls through. */
function readReadme(localPath: string): { name: string; content: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(localPath).sort();
  } catch {
    return null;
  }
  for (const pattern of README_PATTERNS) {
    const name = entries.find((entry) => pattern.test(entry));
    if (!name) continue;
    try {
      const content = readFileSync(join(localPath, name), "utf8");
      return {
        name,
        content: content.length > MAX_README_CHARS
          ? `${content.slice(0, MAX_README_CHARS)}\n\n[README truncated at 8K chars]`
          : content,
      };
    } catch {
      // a directory or unreadable file named like a README: try the next
    }
  }
  return null;
}

/**
 * Render a checkout view for the agent: repository root (structure + README),
 * a subdirectory listing, or a file path (its checkout path and size). `path`
 * is repo-relative and traversal-guarded; a path that is missing, unreadable,
 * or escapes the checkout degrades to the root view, never outside reads.
 */
export function renderRepoView(
  localPath: string,
  view: { type: "root" | "tree"; path?: string },
): string {
  if (view.type === "tree" && view.path) {
    const target = resolveWithinRepo(localPath, view.path);
    // Missing, unreadable, or escaping: the fallback view owns all three.
    const stat = target ? safeStat(target) : undefined;
    if (stat?.isDirectory()) {
      return [
        clonedTo(localPath),
        `Directory: ${join(localPath, view.path)}`,
        "",
        `## ${view.path}`,
        buildDirListing(localPath, view.path),
        "",
        EXPLORE_HINT,
      ].join("\n");
    }
    if (stat) {
      // The path exists but is a file: name it and where it lives rather than
      // claiming it is missing.
      return [
        clonedTo(localPath),
        `File: ${join(localPath, view.path)} (${formatSize(stat.size)})`,
        "",
        FILE_HINT,
      ].join("\n");
    }
    return [
      clonedTo(localPath),
      `Path \`${view.path}\` is not available in this checkout. Showing repository root instead.`,
      SHALLOW_NOTE,
      "",
      "## Structure",
      buildTree(localPath),
      "",
      EXPLORE_HINT,
    ].join("\n");
  }
  const parts = [clonedTo(localPath), SHALLOW_NOTE, "", "## Structure", buildTree(localPath), ""];
  const readme = readReadme(localPath);
  if (readme) parts.push(`## ${readme.name}`, readme.content, "");
  parts.push(EXPLORE_HINT);
  return parts.join("\n");
}
