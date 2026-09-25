// exa-setup.ts — guided Exa API key setup (`/exa-setup`).
//
// A thin instance of the shared key-setup skeleton (search/key-setup.ts):
// the flow (intro → dashboard → paste → validate → save → done), the
// spinner, redaction, the headless fallback, and the reopen guard all live
// in the skeleton. What's Exa-specific stays here:
//
//   • mcp.json detection & removal — pi-reader no longer reads mcp.json for
//     credentials, so the wizard imports a key found there and offers to
//     delete the duplicate entry (opt-in, confirmation-gated, never clobber:
//     a malformed mcp.json is reported with manual instructions, never
//     overwritten).
//   • validation issues one web_search_exa with numResults: 1 through the
//     same MCP client the adapter uses — ~$0.005 of search credit when the
//     key is valid, nothing when it isn't (401s arrive before metering).
//
// The key is never rendered (masked in previews, redacted from error text).

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXA_MCP_URL,
  callExaTool,
  exaKeySource,
  resetExaKeyCache,
} from "./exa-mcp.ts";
import {
  KeySetupWizard,
  isCloseKey,
  openKeySetup,
  redact,
  type KeySetupSpec,
  type ValidationResult,
  type WizardPhase,
} from "./key-setup.ts";
import { configPath, loadConfig, saveConfig, type PiWebConfig } from "../config.ts";

const DASHBOARD_URL = "https://dashboard.exa.ai/api-keys";
const VALIDATE_TIMEOUT_MS = 20_000;

// ── mcp.json paths (the foreign config we detect in, import from, dedupe) ────

export function mcpConfigPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".pi", "agent", "mcp.json"),
    join(home, ".pi", "mcp.json"),
    join(process.cwd(), ".pi", "mcp.json"),
  ];
}

// ── mcp.json detection & removal ─────────────────────────────────────────────

export interface McpExaEntry {
  /** Config file the entry was found in. */
  path: string;
  url: string;
  apiKey: string | null;
  /** True when the entry exposes exa tools directly to the agent. */
  directTools: boolean;
}

export function findMcpExaEntry(path: string): McpExaEntry | null {
  let parsed: { mcpServers?: Record<string, { url?: unknown; directTools?: unknown }> };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // missing or unreadable — nothing to import or warn about
  }
  const entry = parsed?.mcpServers?.exa;
  if (!entry || typeof entry !== "object") return null;
  const url = typeof entry.url === "string" ? entry.url : null;
  if (!url) return null;
  const apiKey = (() => {
    try {
      return new URL(url).searchParams.get("exaApiKey");
    } catch {
      return null;
    }
  })();
  return { path, url, apiKey, directTools: entry.directTools === true };
}

/**
 * The duplication condition: an mcp.json exa entry that exposes exa tools
 * directly (directTools: true) while pi-reader's own tools cover the same
 * capability. Drives the session-start warning and the once-per-user prompt.
 */
export function detectMcpDuplicate(): McpExaEntry | null {
  for (const path of mcpConfigPaths()) {
    const entry = findMcpExaEntry(path);
    if (entry?.directTools) return entry;
  }
  return null;
}

/** First mcp.json entry with an importable key (directTools or not). */
export function findImportableMcpExaKey(): McpExaEntry | null {
  for (const path of mcpConfigPaths()) {
    const entry = findMcpExaEntry(path);
    if (entry?.apiKey) return entry;
  }
  return null;
}

/** Delete the exa server entry, preserving every other server. Never clobbers malformed JSON. */
export function removeMcpExaEntry(path: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error("the file is not valid JSON");
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("mcpServers is missing or not an object");
  }
  if (!("exa" in (servers as Record<string, unknown>))) return; // nothing to remove
  delete (servers as Record<string, unknown>).exa;
  const tmp = join(dirname(path), `.${Math.random().toString(16).slice(2)}.mcp.json.tmp`);
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

// ── Key validation (one cheap search; 401s arrive before metering) ───────────

export async function validateExaKey(key: string, signal?: AbortSignal): Promise<ValidationResult> {
  try {
    await callExaTool("web_search_exa", { query: "test", numResults: 1 }, {
      apiKey: key,
      signal,
      timeoutMs: VALIDATE_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), key);
    if (/\b401\b|\b403\b|invalid api key|unauthorized/i.test(reason)) {
      return { ok: false, kind: "invalid", reason };
    }
    if (/\b429\b|rate.?limit|too many requests|quota/i.test(reason)) {
      return { ok: false, kind: "rate-limited", reason };
    }
    return { ok: false, kind: "unreachable", reason };
  }
}

// ── The Exa instance — skeleton + import and dedupe-removal places ──────────

export class ExaSetupWizard extends KeySetupWizard {
  private imported = false; // true when the key came from the mcp.json import
  private mcpEntry: McpExaEntry | null = null; // set at Intro; removal target after save
  private removeError: string | null = null;
  private removedMcp = false;

  constructor(spec: KeySetupSpec, options: { theme: Theme; onClose: () => void; requestRender: () => void }) {
    super(spec, options);
    this.mcpEntry = findImportableMcpExaKey();
  }

  protected override handlePhaseInput(data: string): boolean {
    if (this.phase === "intro") {
      // Import: only the explicit 'i' key; Enter keeps opening the dashboard.
      if (this.mcpEntry?.apiKey && matchesKey(data, "i")) {
        this.key = this.mcpEntry.apiKey.trim();
        this.imported = true;
        this.startValidation();
        return true;
      }
      return false;
    }
    if (this.phase === "remove") {
      if (isCloseKey(data)) this.go("done"); // skip removal
      else if (matchesKey(data, Key.enter)) this.removeEntry();
      else if (matchesKey(data, "s")) this.go("done");
      return true;
    }
    return false;
  }

  protected override pasteInstructions(): string {
    return this.imported
      ? "Re-enter a key (the imported one was rejected):"
      : this.spec.pasteInstructions;
  }

  protected override showDashboardAtPaste(): boolean {
    return !this.imported;
  }

  protected override introHintLines(): string[] {
    return this.mcpEntry?.apiKey
      ? [`Found a key in ${this.mcpEntry.path} — press i to import it.`]
      : [];
  }

  protected override introFooter(hasHint: boolean): string {
    return hasHint
      ? "i import found key · enter open dashboard · esc close"
      : super.introFooter(hasHint);
  }

  protected override onSaved(): void {
    this.imported = false;
    // Offer dedup exactly when a live mcp.json exa entry would duplicate
    // the agent-facing surface.
    const duplicate = detectMcpDuplicate();
    if (duplicate) {
      this.mcpEntry = duplicate;
      this.go("remove");
    } else {
      this.go("done");
    }
  }

  protected override doneLines(): string[] {
    const lines: string[] = [];
    if (this.removedMcp) {
      lines.push(`Removed the exa entry from ${this.mcpEntry?.path}.`);
    }
    if (this.removeError) {
      lines.push(`✗ Could not remove the mcp.json entry: ${this.removeError} — the key is saved; remove it by hand to dedupe.`);
    }
    return lines;
  }

  protected override renderPhase(add: (s?: string) => void, wrap: (text: string, style?: "text" | "dim" | "error" | "warning" | "accent", indent?: number) => void): boolean {
    if (this.phase !== "remove") return false;
    wrap("Duplicate found: mcp.json also exposes Exa tools.");
    add();
    wrap("Remove it? Both tool sets load in every session until removed.", "text");
    add();
    if (this.mcpEntry) {
      wrap(`Target: ${this.mcpEntry.path}. Other servers untouched.`, "dim");
    }
    return true;
  }

  protected override phaseFooter(phase: WizardPhase): string | null {
    return phase === "remove" ? "enter remove duplicate · s skip · esc skip" : null;
  }

  private removeEntry(): void {
    try {
      removeMcpExaEntry(this.mcpEntry!.path);
      this.removedMcp = true;
      this.removeError = null;
      this.go("done");
    } catch (err) {
      this.removeError = err instanceof Error && err.message ? err.message : String(err);
      this.go("done"); // key is saved; removal failure is reported, not fatal
    }
  }
}

// ── The Exa spec + opener ────────────────────────────────────────────────────

const exaSpec: KeySetupSpec = {
  title: "Exa setup",
  dashboardUrl: DASHBOARD_URL,
  introLines: ["Exa semantic search needs a key. Search and fetch work without one."],
  currentKeyLabel: () => exaKeySource(),
  pasteInstructions: "On the dashboard: API Keys -> Create key -> copy it.",
  validatingLabel: "Testing the key (one search)...",
  validate: validateExaKey,
  save(key) {
    const current = loadConfig();
    const next: PiWebConfig = {
      ...(current ?? {}),
      version: 1,
      exa: {
        url: current?.exa?.url ?? EXA_MCP_URL,
        apiKey: key,
      },
    };
    saveConfig(configPath(), next);
  },
  afterSave: () => resetExaKeyCache(), // lazy resolution: the next Exa call sees the new key
  previewConfig(key) {
    const current = loadConfig();
    return {
      ...(current ?? {}),
      version: 1 as const,
      exa: {
        url: current?.exa?.url ?? EXA_MCP_URL,
        apiKey: "•".repeat(Math.min(key.length, 12)),
      },
    };
  },
  manualInstructions:
    `The Exa setup wizard needs TUI mode. To add the key by hand, either set EXA_API_KEY in your environment or create ${configPath()}:\n` +
    `  { "version": 1, "exa": { "url": "${EXA_MCP_URL}", "apiKey": "<your-key>" } }\n` +
    `Create a key at ${DASHBOARD_URL}`,
  writeErrorHint: "Fix by hand: set EXA_API_KEY, or check permissions on ~/.pi/agent/ and re-run /exa-setup.",
};

export function openExaSetup(ctx: ExtensionCommandContext): void {
  openKeySetup(ctx, exaSpec, (wiring) => new ExaSetupWizard(exaSpec, wiring));
}
