// openalex-setup.ts — `/openalex-setup`, the thinnest instance of the skeleton:
// no mcp.json import or removal place, because this key never lived there.
//
// Validation is one singleton work lookup, which is free — so a valid key costs
// nothing to prove, unlike Exa's metered probe. Rejection classes mirror the
// papers error contract, and the done screen reads the real budget from
// /rate-limit.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  KeySetupWizard,
  openKeySetup,
  redact,
  type KeySetupSpec,
  type ValidationResult,
} from "./key-setup.ts";
import { openAlexErrorDetail, openAlexHeaders, parseOpenAlexRateLimitHeaders, resolveOpenAlexKey } from "./papers.ts";
import { configPath, loadConfig, saveConfig, type PiWebConfig } from "../config.ts";

const DASHBOARD_URL = "https://openalex.org/settings/api";
const RATE_LIMIT_URL = "https://api.openalex.org/rate-limit";
const VALIDATE_TIMEOUT_MS = 20_000;
/** Any real work id — the singleton lookup is free, so the probe costs nothing. */
const PROBE_WORK = "W3161425918";

// Validation — one free singleton lookup

/** Map a probe response to the shared validation shape. Pure; exported for
 *  tests — the fetch wrapper around it is the only I/O. */
export function classifyOpenAlexValidation(
  ok: boolean,
  status: number,
  remaining: number | null,
  remainingUsd: number | null,
  key: string,
): ValidationResult {
  if (ok) return { ok: true };
  const detail = openAlexErrorDetail(status, { remaining, remainingUsd, resetSeconds: null, retryAfterSeconds: null }, true)
    ?? `OpenAlex returned ${status}`;
  const reason = redact(detail, key);
  if (status === 401 || status === 403) return { ok: false, kind: "invalid", reason };
  if (status === 429) return { ok: false, kind: "rate-limited", reason };
  return { ok: false, kind: "unreachable", reason };
}

export async function validateOpenAlexKey(key: string, signal?: AbortSignal): Promise<ValidationResult> {
  try {
    const url = `https://api.openalex.org/works/${PROBE_WORK}`;
    const res = await fetch(url, {
      headers: openAlexHeaders(key),
      signal: AbortSignal.any(
        signal ? [AbortSignal.timeout(VALIDATE_TIMEOUT_MS), signal] : [AbortSignal.timeout(VALIDATE_TIMEOUT_MS)],
      ),
    });
    const rl = parseOpenAlexRateLimitHeaders(res.headers);
    return classifyOpenAlexValidation(res.ok, res.status, rl.remaining, rl.remainingUsd, key);
  } catch (err) {
    return { ok: false, kind: "unreachable", reason: redact(err instanceof Error ? err.message : String(err), key) };
  }
}

// The done-screen budget readout (free /rate-limit call)

/** The real daily budget and reset, straight from the endpoint. Never
 *  invented: a failed or unreadable readout is reported as such, and the
 *  key is redacted from anything that could echo it. */
export async function openAlexBudgetLines(key: string): Promise<string[]> {
  try {
    const res = await fetch(RATE_LIMIT_URL, {
      headers: openAlexHeaders(key),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return [`Could not read the budget: OpenAlex returned ${res.status}.`];
    }
    const body: unknown = await res.json();
    return [`Daily budget (from OpenAlex): ${JSON.stringify(body).slice(0, 200)}`];
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), key);
    return [`Could not read the budget: ${message}`];
  }
}

// The OpenAlex spec + opener

const openalexSpec: KeySetupSpec = {
  title: "OpenAlex setup",
  dashboardUrl: DASHBOARD_URL,
  introLines: [
    "Papers search (provider \"papers\", index \"openalex\") works without a key, but the free anonymous budget is about 100 searches a day.",
    "A free OpenAlex API key raises it 10×. Get one at openalex.org/settings/api.",
  ],
  currentKeyLabel: () => {
    const key = resolveOpenAlexKey(loadConfig()?.papers?.openalexApiKey, process.env.OPENALEX_API_KEY);
    if (key === null) return null;
    return loadConfig()?.papers?.openalexApiKey?.trim() ? "config" : "environment";
  },
  pasteInstructions: "On the dashboard: Settings -> API -> create a key, copy it.",
  validatingLabel: "Testing the key (one free lookup)...",
  validate: validateOpenAlexKey,
  save(key) {
    const current = loadConfig();
    const next: PiWebConfig = {
      ...(current ?? {}),
      version: 1,
      papers: {
        ...(current?.papers ?? {}),
        openalexApiKey: key,
      },
    };
    saveConfig(configPath(), next);
  },
  previewConfig(key) {
    const current = loadConfig();
    return {
      ...(current ?? {}),
      version: 1 as const,
      papers: {
        ...(current?.papers ?? {}),
        openalexApiKey: "•".repeat(Math.min(key.length, 12)),
      },
    };
  },
  // The Exa wizard cannot give this feedback: the real budget, read live
  // from the free /rate-limit endpoint after the save (the config holds the
  // key by then).
  doneLinesAsync: () => openAlexBudgetLines(
    resolveOpenAlexKey(loadConfig()?.papers?.openalexApiKey, process.env.OPENALEX_API_KEY) ?? "",
  ),
  manualInstructions:
    `The OpenAlex setup wizard needs TUI mode. To add the key by hand, either set OPENALEX_API_KEY in your environment or create ${configPath()}:\n` +
    `  { "version": 1, "papers": { "openalexApiKey": "<your-key>" } }\n` +
    `Create a key at ${DASHBOARD_URL}`,
  writeErrorHint: "Fix by hand: set OPENALEX_API_KEY, or check permissions on ~/.pi/agent/ and re-run /openalex-setup.",
};

export function openOpenAlexSetup(ctx: ExtensionCommandContext): void {
  openKeySetup(ctx, openalexSpec, (wiring) => new KeySetupWizard(openalexSpec, wiring));
}
