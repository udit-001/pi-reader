// parallel-setup.ts — guided Parallel API key setup (`/parallel-setup`).
//
// A thin instance of the shared key-setup skeleton (search/key-setup.ts):
// the flow, spinner, redaction, headless fallback, and reopen guard live in
// the skeleton. What's Parallel-specific is only the spec — and unlike Exa
// there is no subclass: the anonymous tier is the default product, so there
// is no mcp.json key to import or duplicate to remove. The wizard exists for
// users who want the raised rate limits, not for search to work at all.
//
// Validation issues one web_search through the same MCP client the adapter
// uses (Bearer header): an invalid key 401s before metering, a valid one
// spends one free-tier (or ~$0.001 paid) search.
//
// The key is never rendered (masked in previews, redacted from error text).

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  PARALLEL_MCP_URL,
  callParallelTool,
  parallelKeySource,
  resetParallelKeyCache,
} from "./parallel-mcp.ts";
import {
  KeySetupWizard,
  openKeySetup,
  redact,
  type KeySetupSpec,
  type ValidationResult,
} from "./key-setup.ts";
import { configPath, loadConfig, saveConfig, type PiWebConfig } from "../config.ts";

const DASHBOARD_URL = "https://platform.parallel.ai";
const VALIDATE_TIMEOUT_MS = 20_000;

// ── Key validation (one cheap search; 401s arrive before metering) ───────────

export async function validateParallelKey(key: string, signal?: AbortSignal): Promise<ValidationResult> {
  try {
    await callParallelTool("web_search", { objective: "test", search_queries: ["test"] }, {
      apiKey: key,
      signal,
      timeoutMs: VALIDATE_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), key);
    if (/\b401\b|\b403\b|unauthorized|invalid api key/i.test(reason)) {
      return { ok: false, kind: "invalid", reason };
    }
    if (/\b429\b|rate.?limit|too many requests|quota/i.test(reason)) {
      return { ok: false, kind: "rate-limited", reason };
    }
    return { ok: false, kind: "unreachable", reason };
  }
}

// ── The Parallel spec + opener ───────────────────────────────────────────────

export const parallelSpec: KeySetupSpec = {
  title: "Parallel setup",
  dashboardUrl: DASHBOARD_URL,
  introLines: [
    // The limping context only: the second line's "those limits" needs it.
    // The keyless reassurance lives on the /search-setup menu (one owner).
    "The free tier: per-session limits.",
    "A key raises those limits and lets you pin default search settings.",
  ],
  currentKeyLabel: () => parallelKeySource(),
  pasteInstructions: "On the dashboard: API Keys -> Create key -> copy it.",
  validatingLabel: "Testing the key (one search)...",
  validate: validateParallelKey,
  save(key) {
    const current = loadConfig();
    const next: PiWebConfig = {
      ...(current ?? {}),
      version: 1,
      parallel: {
        url: current?.parallel?.url ?? PARALLEL_MCP_URL,
        apiKey: key,
      },
    };
    saveConfig(configPath(), next);
  },
  afterSave: () => resetParallelKeyCache(), // lazy resolution: the next call picks up the new key
  previewConfig(key) {
    const current = loadConfig();
    return {
      ...(current ?? {}),
      version: 1 as const,
      parallel: {
        url: current?.parallel?.url ?? PARALLEL_MCP_URL,
        apiKey: "•".repeat(Math.min(key.length, 12)),
      },
    };
  },
  manualInstructions:
    `The Parallel setup wizard needs TUI mode. To add the key by hand, either set PARALLEL_API_KEY in your environment or create ${configPath()}:\n` +
    `  { "version": 1, "parallel": { "url": "${PARALLEL_MCP_URL}", "apiKey": "<your-key>" } }\n` +
    `Create a key at ${DASHBOARD_URL}`,
  writeErrorHint: "Fix by hand: set PARALLEL_API_KEY, or check permissions on ~/.pi/agent/ and re-run /parallel-setup.",
};

/** @deprecated Callers recover through /search-setup (setup-menu.ts). Kept
 *  only where the menu itself constructs its wizards; not exported to new
 *  code. */
export function openParallelSetup(ctx: ExtensionCommandContext): void {
  openKeySetup(ctx, parallelSpec, (wiring) => new KeySetupWizard(parallelSpec, wiring));
}
