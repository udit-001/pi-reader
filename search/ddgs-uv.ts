// ddgs-uv.ts — DuckDuckGo search via the ddgs Python package (uvx).
//
// Wraps `uvx ddgs text` to get TLS fingerprinting and VQD token handling
// for free. Auto-installs uv on first use if missing. Falls back to HTML
// scraping when uvx is unavailable.

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SearchOptions, SearchResult } from "./search.ts";

const INSTALL_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 30_000;

// ── uvx path resolution ─────────────────────────────────────────────────────

// Default install location used by the official uv installer on each platform.
// Other install methods (brew, apt, pip, scoop, winget) put uvx on PATH
// instead — uvxBinary() falls back to bare "uvx" so the shell resolves it.
export function uvxInstallPath(platform: string, home: string): string {
  const bin = join(home, ".local", "bin");
  return platform === "win32" ? join(bin, "uvx.exe") : join(bin, "uvx");
}

function uvxBinary(): string {
  const installPath = uvxInstallPath(process.platform, homedir());
  if (existsSync(installPath)) return installPath;
  return "uvx"; // PATH fallback: brew, apt, pip, scoop, winget installs
}

export function hasUvx(): boolean {
  try {
    execSync(`"${uvxBinary()}" --version`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── uv installation ─────────────────────────────────────────────────────────

export function installUv(): void {
  const binDir = dirname(uvxInstallPath(process.platform, homedir()));
  mkdirSync(binDir, { recursive: true });
  execSync(uvInstallCommand(process.platform), { stdio: "pipe", timeout: INSTALL_TIMEOUT_MS });
}

// ── session-start warm-up ────────────────────────────────────────────────────

// The install step, as a shell command — shared by the sync installUv() and
// the async warm-up so both stay in sync per platform.
export function uvInstallCommand(platform: string): string {
  if (platform === "win32") {
    return 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"';
  }
  return "curl -LsSf https://astral.sh/uv/install.sh | sh";
}

// The probe commands for warming the ddgs path, in order: the official
// install location first, then bare "uvx" so the shell resolves it via PATH
// (brew, apt, pip, scoop installs). Running any one of these drops the ddgs
// package into uv's cache. Pure — lets tests pin the plan without spawning
// processes.
export function probeCommands(platform: string, home: string): string[] {
  return [`"${uvxInstallPath(platform, home)}" ddgs --help`, "uvx ddgs --help"];
}

const runQuietly = promisify(exec);
let warmStarted = false;

// The warm sequence, given probes and an install command. Exported as an
// internal seam so tests can pin the flow (probe order, install-then-retry)
// without touching the once-per-process guard.
export async function warmFlow(
  run: (cmd: string) => Promise<unknown>,
  probes: string[],
  installCmd: string,
): Promise<void> {
  for (const probe of probes) {
    try {
      await run(probe);
      return; // ddgs is cached — done
    } catch { /* try the next probe */ }
  }
  // No usable uvx anywhere — install it, then retry the primary probe.
  try {
    await run(installCmd);
  } catch {
    return; // degraded is fine — the HTML fallback covers search
  }
  const primary = probes[0];
  if (!primary) return;
  try {
    await run(primary);
  } catch { /* give up quietly */ }
}

// Fire-and-forget warm-up for session start: moves the one-time uv/ddgs
// download off the critical path of the user's first search. Fully async
// (no sync execSync on the session-start path), never blocks, never throws
// — if it fails, search falls back to HTML scraping as before.
// Returns the promise so tests can await completion; callers may ignore it.
export function warmDdgs(
  run: (cmd: string) => Promise<unknown> = runQuietly,
): Promise<void> {
  if (warmStarted) return Promise.resolve();
  warmStarted = true;
  return warmFlow(run, probeCommands(process.platform, homedir()), uvInstallCommand(process.platform));
}

// ── recency → ddgs timelimit ─────────────────────────────────────────────────────────────────────────

// SearchOptions.recency → ddgs `-t` letter code. The HTML fallback's `df=`
// param uses the same letter codes, so this map is the single source of truth
// for both adapters.
export const REGENCY_TO_TIMELIMIT: Record<string, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

export function timelimitFor(recency?: SearchOptions["recency"]): string | null {
  if (!recency) return null;
  return REGENCY_TO_TIMELIMIT[recency] ?? null;
}

// ── ddgs command plan ────────────────────────────────────────────────────────────────────────────────

export interface DdgsTextArgs {
  query: string;
  maxResults: number;
  timelimit?: string | null;
  uvx: string;
  output: string;
}

// The full `uvx ddgs text` command as one pure plan — tests pin the flags
// without spawning processes, matching the probeCommands pattern above.
export function buildDdgsTextCommand(a: DdgsTextArgs): string {
  const parts = [
    `"${a.uvx}"`,
    "ddgs", "text",
    "-q", `"${a.query.replace(/"/g, '\\"')}"`,
  ];
  if (a.timelimit) parts.push("-t", a.timelimit);
  parts.push("-m", String(a.maxResults));
  parts.push("-o", `"${a.output}"`);
  return parts.join(" ");
}

// ── ddgs search ─────────────────────────────────────────────────────────────

export function searchViaDdgs(
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const maxResults = options.numResults ?? 10;
  const uvx = uvxBinary();
  const tmpFile = join(tmpdir(), `ddgs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    // Build query with site: operators
    const includeDomains = (options.domains ?? [])
      .filter((d) => !d.startsWith("-") && d.length > 0);
    const excludeDomains = (options.domains ?? [])
      .filter((d) => d.startsWith("-") && d.length > 1)
      .map((d) => d.slice(1));

    const siteOps: string[] = [];
    if (includeDomains.length > 0) {
      siteOps.push(includeDomains.map((d) => `site:${d}`).join(" OR "));
    }
    if (excludeDomains.length > 0) {
      siteOps.push(excludeDomains.map((d) => `-site:${d}`).join(" "));
    }
    const fullQuery = siteOps.length > 0 ? `${query} ${siteOps.join(" ")}` : query;

    // Run uvx ddgs
    const command = buildDdgsTextCommand({
      query: fullQuery,
      maxResults,
      timelimit: timelimitFor(options.recency),
      uvx,
      output: tmpFile,
    });

    execSync(command, {
      stdio: "pipe",
      timeout: SEARCH_TIMEOUT_MS,
    });

    // Parse results
    const raw = JSON.parse(readFileSync(tmpFile, "utf-8")) as Array<{
      title?: string;
      href?: string;
      body?: string;
    }>;

    return raw.map((r) => ({
      title: r.title ?? "",
      url: r.href ?? "",
      snippet: r.body ?? "",
    }));
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
