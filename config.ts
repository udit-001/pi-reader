// config.ts — pi-reader's own config file: key residency and hint state.
//
// The file is ours alone (~/.pi/agent/pi-reader.json, named for the package,
// living in the same directory convention as pi's mcp.json). Nobody else
// reads or writes it, which is the point: pi-reader's credentials no longer
// share state with another system's config.
//
// Reads are forgiving on purpose — a missing OR malformed file reads as null
// (DuckDuckGo keeps working; the wizard's next save replaces the file with
// valid JSON). Writes are atomic (tmp + rename) so a crash can't leave a
// half-written config behind.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PiWebConfig {
  version: 1;
  /** Exa MCP credentials. Absent when only hint state is stored. */
  exa?: {
    url: string;
    apiKey: string;
  };
  /** One-shot UX flags, persisted so prompts fire once per user. */
  hints?: {
    /** ISO timestamp when the mcp.json duplication prompt was shown. */
    mcpDuplicate?: string;
  };
  /** GitHub repo cloning (see fetch/github-clone.ts). Absent fields use defaults. */
  githubClone?: {
    /** Set false to stop cloning repo URLs (they fall back to the API view). */
    enabled?: boolean;
    /** Refuse to clone repos larger than this (MB). Default 350. */
    maxRepoSizeMB?: number;
    /** git/gh clone subprocess timeout (seconds). Default 30. */
    cloneTimeoutSeconds?: number;
    /** Where checkouts live. Default /tmp/pi-github-repos. ~ and $VAR expand. */
    clonePath?: string;
  };
  /** GitHub issue/PR rendering (see fetch/github-issue-pr.ts). */
  githubIssuePr?: {
    /** Set false to skip gh and render via the REST API only. Default true. */
    enabled?: boolean;
  };
  /** Allow fetching loopback/private-network addresses (intranet wikis, local dev
   *  servers). Default false. Cached responses are written 0600 either way. */
  allowPrivateNetwork?: boolean;
}

export function configPath(): string {
  return join(homedir(), ".pi", "agent", "pi-reader.json");
}

export function loadConfig(path: string = configPath()): PiWebConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null; // missing
  }
  try {
    const parsed = JSON.parse(text) as PiWebConfig;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null; // malformed — our file, self-heals on next save
  }
}

export function saveConfig(path: string, config: PiWebConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${Math.random().toString(16).slice(2)}.pi-reader.json.tmp`);
  // 0600: this file carries the Exa API key.
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}
