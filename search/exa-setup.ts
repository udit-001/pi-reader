// exa-setup.ts — guided Exa API key setup (`/exa-setup`).
//
// A wizard in the wizard-skill sense, rendered as an inline TUI component in
// the pi-go-usage pattern (`ctx.ui.custom`, theme.fg styling, keyboard-only,
// footer hints). Places:
//
//   Intro      i imports a key found in mcp.json    → Validating
//              enter opens the dashboard            → Paste
//              esc closes
//   Paste      hidden key entry                     → Validating
//   Validating one cheap tools/call check           → Save
//   Save       previews pi-reader.json, enter writes   → Remove (if duplicate)
//   Remove     opt-in deletion of the mcp.json exa  → Done
//   Done       what was written
//
// plus an Error place for the never-clobber path: a malformed mcp.json is
// reported with manual instructions, never overwritten. pi-reader.json is our
// own file and self-heals (malformed reads as null; the wizard's save
// replaces it with valid JSON).
//
// Validation issues one web_search_exa with numResults: 1 through the same
// MCP client the adapter uses — it costs ~$0.005 of search credit when the
// key is valid and nothing when it isn't (401s arrive before metering).
//
// The key is never rendered (masked in previews, redacted from error text).

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  EXA_MCP_URL,
  EXA_TOOLS,
  callExaTool,
  exaKeySource,
  resetExaKeyCache,
} from "./exa-mcp.ts";
import { configPath, loadConfig, saveConfig, type PiWebConfig } from "../config.ts";

const DASHBOARD_URL = "https://dashboard.exa.ai/api-keys";
const VALIDATE_TIMEOUT_MS = 20_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;
const WIZARD_WIDTH = 72;

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
// pi-reader no longer reads mcp.json for credentials. findMcpExaEntry is the
// read-only detector behind the wizard's import offer and the session-start
// dedup warning; removeMcpExaEntry is the opt-in, confirmation-gated surgery
// that deletes exactly the exa server and nothing else — never clobber.

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

// ── Masking / redaction ──────────────────────────────────────────────────────

/** Scrub a secret from text before it can reach an error surface. */
export function redact(text: string, secret: string): string {
  if (secret.length > 4) return text.split(secret).join("[redacted]");
  return text;
}

// ── Key validation (one cheap search; 401s arrive before metering) ───────────

export type ValidationOk = { ok: true };
export type ValidationFail =
  | { ok: false; kind: "invalid"; reason: string }
  | { ok: false; kind: "rate-limited"; reason: string }
  | { ok: false; kind: "unreachable"; reason: string };
export type ValidationResult = ValidationOk | ValidationFail;

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

// ── Wizard state ─────────────────────────────────────────────────────────────

type WizardPhase = "intro" | "paste" | "validating" | "save" | "remove" | "done" | "error";

const closeKeys = (data: string): boolean =>
  matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));

export class ExaSetupWizard {
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly requestRender: () => void;

  private phase: WizardPhase = "intro";
  private key = "";
  private imported = false; // true when the key came from the mcp.json import
  private pasteError: string | null = null; // last validation failure, shown at Paste
  private pasteErrorKind: "invalid" | "rate-limited" | "unreachable" | null = null;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private validationAbort: AbortController | null = null;
  private mcpEntry: McpExaEntry | null = null; // set at Intro; removal target after save
  private removeError: string | null = null;
  private wrote: { configPath: string; removedMcp: boolean } | null = null;
  private writeError: string | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: { theme: Theme; onClose: () => void; requestRender: () => void }) {
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRender = options.requestRender;
    this.mcpEntry = findImportableMcpExaKey();
  }

  dispose(): void {
    this.stopSpinner();
    this.validationAbort?.abort();
    this.validationAbort = null;
  }

  handleInput(data: string): void {
    switch (this.phase) {
      case "intro":
        if (closeKeys(data) || matchesKey(data, "q")) this.onClose();
        else if (this.mcpEntry?.apiKey && (matchesKey(data, "i") || matchesKey(data, Key.enter))) {
          if (matchesKey(data, "i")) this.startImport();
          else this.enterFromIntro();
        }
        else if (matchesKey(data, Key.enter)) this.enterFromIntro();
        return;
      case "paste":
        this.handlePasteInput(data);
        return;
      case "validating":
        if (closeKeys(data)) this.cancelValidation();
        return;
      case "save":
        if (closeKeys(data)) this.backToPaste();
        else if (matchesKey(data, Key.enter)) this.write();
        return;
      case "remove":
        if (closeKeys(data)) this.go("done"); // skip removal
        else if (matchesKey(data, Key.enter)) this.removeEntry();
        else if (matchesKey(data, "s")) this.go("done");
        return;
      case "done":
      case "error":
        if (closeKeys(data) || matchesKey(data, Key.enter) || matchesKey(data, "q")) this.onClose();
        return;
    }
  }

  private enterFromIntro(): void {
    openUrlBestEffort(DASHBOARD_URL);
    this.pasteError = null;
    this.pasteErrorKind = null;
    this.go("paste");
  }

  private startImport(): void {
    this.key = this.mcpEntry!.apiKey!.trim();
    this.imported = true;
    this.startValidation();
  }

  private handlePasteInput(data: string): void {
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (this.key.trim().length > 0) this.startValidation();
      return;
    }
    if (closeKeys(data)) {
      this.go("intro");
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.key = this.key.slice(0, -1);
      this.invalidate();
      return;
    }
    // Bracketed paste: ESC[200~ <text> ESC[201~ — strip markers, take content.
    const bracketed = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(data);
    if (bracketed) {
      this.key = bracketed[1]!.replace(/[\r\n]/g, "").trim();
      this.pasteError = null;
      this.invalidate();
      return;
    }
    if (data.startsWith("\x1b")) return; // other escape sequences aren't text
    if (/^[\x20-\x7e]+$/.test(data)) {
      this.key += data;
      this.pasteError = null;
      this.invalidate();
    }
  }

  private startValidation(): void {
    this.go("validating");
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, SPINNER_MS);
    this.validationAbort = new AbortController();
    const key = this.key.trim();
    void validateExaKey(key, this.validationAbort.signal)
      .then((result) => {
        if (this.phase !== "validating") return; // cancelled meanwhile
        this.stopSpinner();
        if (result.ok) {
          this.go("save");
        } else {
          this.pasteErrorKind = result.kind;
          this.pasteError = result.reason;
          this.go("paste");
        }
      })
      .catch(() => {
        if (this.phase !== "validating") return;
        this.stopSpinner();
        this.pasteErrorKind = "unreachable";
        this.pasteError = "validation failed";
        this.go("paste");
      });
  }

  private cancelValidation(): void {
    this.stopSpinner();
    this.validationAbort?.abort();
    this.validationAbort = null;
    this.go("paste");
  }

  private backToPaste(): void {
    this.imported = false;
    this.go("paste");
  }

  private write(): void {
    try {
      const current = loadConfig();
      const next: PiWebConfig = {
        ...(current ?? {}),
        version: 1,
        exa: {
          url: current?.exa?.url ?? EXA_MCP_URL,
          apiKey: this.key.trim(),
        },
      };
      saveConfig(configPath(), next);
      resetExaKeyCache(); // lazy resolution: the next Exa call sees the new key
      this.wrote = { configPath: configPath(), removedMcp: false };
      // Offer dedup exactly when a live mcp.json exa entry would duplicate
      // the agent-facing surface.
      const duplicate = detectMcpDuplicate();
      if (duplicate) {
        this.mcpEntry = duplicate;
        this.go("remove");
      } else {
        this.go("done");
      }
    } catch (err) {
      this.writeError = err instanceof Error && err.message
        ? redact(err.message, this.key)
        : String(err);
      this.go("error");
    }
  }

  private removeEntry(): void {
    try {
      removeMcpExaEntry(this.mcpEntry!.path);
      this.wrote = { configPath: this.wrote?.configPath ?? configPath(), removedMcp: true };
      this.removeError = null;
      this.go("done");
    } catch (err) {
      this.removeError = err instanceof Error && err.message ? err.message : String(err);
      this.go("done"); // key is saved; removal failure is reported, not fatal
    }
  }

  private go(phase: WizardPhase): void {
    this.phase = phase;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.requestRender();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const W = Math.min(width, WIZARD_WIDTH);
    const lines: string[] = [];
    const add = (s = "") => lines.push(s);
    const wrap = (text: string, style: "text" | "dim" | "error" | "warning" | "accent" = "text", indent = 0) => {
      const pad = " ".repeat(2 + indent);
      for (const l of wrapTextWithAnsi(text, W - 2 - indent)) {
        lines.push(`${pad}${this.theme.fg(style, l)}`);
      }
    };

    add(this.theme.fg("border", "─".repeat(W)));
    add(`  ${this.theme.fg("accent", this.theme.bold("Exa setup"))}`);
    add();

    switch (this.phase) {
      case "intro": {
        wrap("Exa powers semantic web search and markdown fetch behind the web_search and web_fetch tools (the fallback tier after free sources).");
        add();
        const source = exaKeySource();
        wrap(source
          ? `Current key: set (${source})`
          : "Current key: none configured");
        if (this.mcpEntry?.apiKey) {
          add();
          wrap(`Found an Exa key in ${this.mcpEntry.path}.`, "accent");
          wrap("i imports it (validated) into pi-reader's own config, then offers to remove the duplicate entry.");
        }
        add();
        wrap("A key is only needed when you hit an Exa rate limit or want its results — DuckDuckGo and the free fetch chain keep working either way.");
        add();
        wrap("Enter opens the Exa dashboard in your browser to create a key.");
        add();
        add(`  ${this.theme.fg("dim", DASHBOARD_URL)}`);
        break;
      }
      case "paste": {
        wrap(this.imported
          ? "Re-enter a key (the imported one was rejected):"
          : "On the dashboard: API Keys → Create key → copy it.");
        if (!this.imported) {
          add();
          add(`  ${this.theme.fg("dim", DASHBOARD_URL)}`);
        }
        add();
        if (this.pasteError) {
          const lead = this.pasteErrorKind === "rate-limited"
            ? "✗ Key is valid but rate-limited right now — saving it won't restore search until the limit resets. "
            : this.pasteErrorKind === "unreachable"
              ? "✗ Could not check the key: "
              : "✗ Invalid key: ";
          wrap(`${lead}${this.pasteError}`, this.pasteErrorKind === "invalid" ? "error" : "warning");
          add();
        }
        wrap("Paste or type the key below (input is hidden):");
        add();
        const masked = "•".repeat(Math.min(this.key.length, 24));
        const cursor = this.key.length > 0 || this.pasteError ? " " : "█";
        add(`  ${this.theme.fg("text", `key: ${masked}${cursor}`)}`);
        break;
      }
      case "validating": {
        const frame = SPINNER_FRAMES[this.spinnerFrame] ?? "⠋";
        add(`  ${this.theme.fg("accent", `${frame} Checking the key against mcp.exa.ai…`)}`);
        add();
        wrap("One test search (numResults 1) — the only call that proves a key works. Invalid keys are rejected before metering.", "dim");
        break;
      }
      case "save": {
        wrap("pi-reader's config will become:", "text");
        add();
        const preview = JSON.stringify(previewConfig(this.key.trim()), null, 2);
        for (const l of preview.split("\n")) {
          lines.push(`    ${this.theme.fg("text", truncateToWidth(l, W - 6, "…"))}`);
        }
        add();
        wrap(`Written to ${configPath()} — pi-reader's own file, replacing nothing else. No restart needed.`, "dim");
        break;
      }
      case "remove": {
        wrap("Found a duplicate: mcp.json still has an exa entry that exposes exa tools directly.");
        add();
        wrap("Remove it? pi-reader no longer reads that entry, and leaving it puts two Exa tool families in every session.", "text");
        add();
        if (this.mcpEntry) {
          wrap(`Target: ${this.mcpEntry.path} — every other server is untouched.`, "dim");
        }
        break;
      }
      case "done": {
        const path = this.wrote?.configPath ?? configPath();
        add(`  ${this.theme.fg("accent", this.theme.bold("✓ Key saved"))}`);
        add();
        wrap(`Wrote ${path}. No restart needed — the next Exa call picks it up.`);
        if (this.wrote?.removedMcp) {
          add();
          wrap(`Removed the exa entry from ${this.mcpEntry?.path} — duplicate tools are gone from your next session.`, "dim");
        }
        if (this.removeError) {
          add();
          wrap(`✗ Could not remove the mcp.json entry: ${this.removeError} — the key is saved; remove it by hand if you want the dedup.`, "warning");
        }
        add();
        wrap("DuckDuckGo search and the free fetch chain keep working either way.", "dim");
        break;
      }
      case "error": {
        add(`  ${this.theme.fg("error", this.theme.bold("✗ Could not save the config"))}`);
        add();
        wrap(`${this.writeError ?? "unknown error"} — nothing was changed.`);
        add();
        wrap("To fix it by hand, set EXA_API_KEY in your environment, or fix the permissions on ~/.pi/agent/ and re-run /exa-setup.");
        break;
      }
    }

    add();
    add(`  ${this.theme.fg("dim", footerFor(this.phase, this.mcpEntry?.apiKey != null))}`);
    add(this.theme.fg("border", "─".repeat(W)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function footerFor(phase: WizardPhase, importable: boolean): string {
  switch (phase) {
    case "intro": return importable
      ? "i import found key · enter open dashboard · esc close, nothing changes"
      : "enter open dashboard · esc close, nothing changes";
    case "paste": return "enter validate · backspace edit · esc back";
    case "validating": return "esc cancel";
    case "save": return "enter write & finish · esc back";
    case "remove": return "enter remove duplicate · s skip · esc skip";
    case "done": return "enter / q close";
    case "error": return "enter / q close";
  }
}

// The Save preview shows the exact config the write would produce, key masked.
function previewConfig(key: string): PiWebConfig {
  const current = loadConfig();
  const preview = {
    ...(current ?? {}),
    version: 1 as const,
    exa: {
      url: current?.exa?.url ?? EXA_MCP_URL,
      apiKey: "•".repeat(Math.min(key.length, 12)),
    },
  };
  return preview;
}

// ── Opening ──────────────────────────────────────────────────────────────────

let wizardOpen = false;

export function openExaSetup(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui") {
    // Headless: no takeover possible — print the manual path instead.
    ctx.ui.notify(
      `The Exa setup wizard needs TUI mode. To add the key by hand, either set EXA_API_KEY in your environment or create ${configPath()}:\n` +
      `  { "version": 1, "exa": { "url": "${EXA_MCP_URL}", "apiKey": "<your-key>" } }\n` +
      `Create a key at ${DASHBOARD_URL}`,
      "info",
    );
    return;
  }
  if (wizardOpen) {
    ctx.ui.notify("The Exa setup wizard is already open.", "info");
    return;
  }

  let wizard: ExaSetupWizard | undefined;
  wizardOpen = true;

  void ctx.ui
    .custom<void>((tui, theme, _keybindings, done) => {
      wizard = new ExaSetupWizard({
        theme,
        onClose: () => done(undefined),
        requestRender: () => tui.requestRender(),
      });
      return {
        render(width: number) {
          return wizard?.render(width) ?? [];
        },
        invalidate() {
          wizard?.invalidate();
        },
        handleInput(data: string) {
          wizard?.handleInput(data);
          tui.requestRender();
        },
      };
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to open the Exa setup wizard: ${message}`, "error");
    })
    .finally(() => {
      wizard?.dispose();
      wizardOpen = false;
    });
}

// Best-effort browser open. The URL is always shown as text too, so a missing
// opener is an inconvenience, not a dead end.
function openUrlBestEffort(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the URL is visible in the wizard
  }
}
