// ddgs-uv.ts — DuckDuckGo search via the ddgs Python package (uvx).
//
// Wraps `uvx ddgs text` to get TLS fingerprinting and VQD token handling
// for free. Auto-installs uv on first use if missing. Falls back to HTML
// scraping when uvx is unavailable.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SearchOptions, SearchResult } from "./search.ts";

const INSTALL_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 30_000;

// ── uvx path resolution ─────────────────────────────────────────────────────

function uvxBinary(): string {
  if (process.platform === "win32") {
    return join(homedir(), ".local", "bin", "uvx.exe");
  }
  return join(homedir(), ".local", "bin", "uvx");
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
  const binDir = dirname(uvxBinary());
  mkdirSync(binDir, { recursive: true });

  if (process.platform === "win32") {
    execSync(
      'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
      { stdio: "pipe", timeout: INSTALL_TIMEOUT_MS },
    );
  } else {
    execSync(
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
      { stdio: "pipe", timeout: INSTALL_TIMEOUT_MS },
    );
  }
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
    const args = [
      `"${uvx}"`,
      "ddgs", "text",
      "-q", `"${fullQuery.replace(/"/g, '\\"')}"`,
      "-m", String(maxResults),
      "-o", `"${tmpFile}"`,
    ];

    execSync(args.join(" "), {
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
