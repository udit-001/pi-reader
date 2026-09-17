// exa-setup.ts — guided Exa API key setup (`/exa-setup`).
//
// A wizard in the wizard-skill sense, rendered as an inline TUI component in
// the pi-go-usage pattern (`ctx.ui.custom`, theme.fg styling, keyboard-only,
// footer hints). Five places, per the breadboard:
//
//   Intro      enter opens the dashboard, → Paste        esc closes
//   Paste      hidden key entry            → Validating  esc back
//   Validating one cheap tools/call check  → Save        invalid → Paste
//   Save       preview, enter writes       → Done        esc back
//   Done       what was written                          q close
//
// plus an Error place for the never-clobber path: a malformed mcp.json is
// reported with manual instructions, never overwritten.
//
// Breadboard amendment: `tools/list` was planned as the zero-cost check, but
// the remote server answers it 200 even for bogus keys — it proves nothing.
// Validation instead issues one web_search_exa with numResults: 1, which
// costs ~$0.005 of search credit when the key is valid and nothing when it
// isn't (401s arrive before metering).
//
// The write seam is pure: withExaKey(configText, key) returns the new config
// text; upsertExaKey is read → transform → atomic write. The key is never
// rendered (masked in previews, redacted from error text).

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { EXA_MCP_URL, EXA_TOOLS, extractResultText, exaKeySource, resetExaKeyCache, mcpConfigPaths } from "./exa-mcp.ts";

const DASHBOARD_URL = "https://dashboard.exa.ai/api-keys";
const VALIDATE_TIMEOUT_MS = 20_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;
const WIZARD_WIDTH = 72;

// ── Pure config transform (the write seam, exported for tests) ───────────────

export interface ExaTransform {
  /** Full config text to write (2-space indent, trailing newline). */
  text: string;
  /** The exa server entry as it now stands, for the Save preview. */
  entry: Record<string, unknown>;
}

/** The canonical destination: pi-native, first in the resolver's order. */
export function canonicalConfigPath(): string {
  return mcpConfigPaths()[0]!;
}

/**
 * Set the exa server's key in a config. `configText` is the current file
 * contents, or null when the file doesn't exist. Throws on malformed JSON —
 * the caller must treat that as never-clobber, not a crash.
 *
 * Existing exa entries keep every sibling field (type, directTools, …) and
 * every other URL param (tools=); only exaApiKey is replaced. Missing entries
 * are created with the same shape pi's own config uses.
 */
export function withExaKey(configText: string | null, key: string): ExaTransform {
  let config: Record<string, unknown>;
  if (configText === null) {
    config = {};
  } else {
    try {
      config = JSON.parse(configText) as Record<string, unknown>;
    } catch {
      throw new Error("the file is not valid JSON");
    }
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("the file does not contain a JSON object");
  }

  const servers = ((): Record<string, unknown> => {
    if (config.mcpServers === undefined) {
      const fresh: Record<string, unknown> = {};
      config.mcpServers = fresh;
      return fresh;
    }
    const existing = config.mcpServers as unknown;
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("mcpServers is not an object");
    }
    return existing as Record<string, unknown>;
  })();

  const entry = ((): Record<string, unknown> => {
    const existing = servers.exa as unknown;
    if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      return existing as Record<string, unknown>;
    }
    const fresh: Record<string, unknown> = {};
    servers.exa = fresh;
    fresh.type = "streamable-http";
    return fresh;
  })();

  entry.url = exaUrlWithKey(typeof entry.url === "string" ? entry.url : undefined, key);

  return {
    text: `${JSON.stringify(config, null, 2)}\n`,
    entry,
  };
}

/** Put `key` into a URL's exaApiKey param, preserving everything else. */
export function exaUrlWithKey(existingUrl: string | undefined, key: string): string {
  const base = existingUrl ?? `${EXA_MCP_URL}?tools=${EXA_TOOLS}`;
  const u = new URL(base);
  u.searchParams.set("exaApiKey", key);
  return u.toString();
}

/** Mask the exaApiKey value in a URL so previews never show the key. */
export function maskKeyInUrl(url: string, maxWidth = WIZARD_WIDTH - 8): string {
  const u = new URL(url);
  const key = u.searchParams.get("exaApiKey");
  const mask = key ? "•".repeat(Math.min(key.length, 12)) : null;
  // Rebuild the query by hand: a masked bullet must stay one visible cell,
  // not percent-encode into nine characters that break the width budget.
  const parts: string[] = [];
  u.searchParams.forEach((value, name) => {
    parts.push(`${name}=${name === "exaApiKey" && mask ? mask : value}`);
  });
  const assemble = () => `${u.origin}${u.pathname}${parts.length ? "?" : ""}${parts.join("&")}`;
  let display = assemble();
  // The tools list is the only long decoration — shorten it before the width
  // cut can eat the key param, which is the whole point of the preview.
  if (display.length > maxWidth) {
    const i = parts.findIndex((p) => p.startsWith("tools="));
    if (i >= 0) {
      parts[i] = "tools=…";
      display = assemble();
    }
  }
  return truncateToWidth(display, maxWidth, "…");
}

/** Scrub a secret from text before it can reach an error surface. */
export function redact(text: string, secret: string): string {
  if (secret.length > 4) return text.split(secret).join("[redacted]");
  return text;
}

/** Read, transform, atomic write. Throws with the reason; file untouched on error. */
export function upsertExaKey(configPath: string, key: string): ExaTransform {
  let configText: string | null = null;
  if (readMayThrow(configPath) !== undefined) {
    configText = readFileSync(configPath, "utf-8");
  }
  const transform = withExaKey(configText, key);
  const tmp = join(dirname(configPath), `.${Math.random().toString(16).slice(2)}.mcp.json.tmp`);
  writeFileSync(tmp, transform.text, "utf-8");
  renameSync(tmp, configPath);
  return transform;
}

// existsSync can't distinguish "missing" from "unreadable"; a permission
// error should surface as a write error, not silently create a new file.
function readMayThrow(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

// ── Key validation (one cheap search; 401s arrive before metering) ───────────

export type ValidationOk = { ok: true };
export type ValidationFail =
  | { ok: false; kind: "invalid"; reason: string }
  | { ok: false; kind: "rate-limited"; reason: string }
  | { ok: false; kind: "unreachable"; reason: string };
export type ValidationResult = ValidationOk | ValidationFail;

export async function validateExaKey(key: string, signal?: AbortSignal): Promise<ValidationResult> {
  const url = `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}&tools=${encodeURIComponent("web_search_exa")}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query: "test", numResults: 1 } },
      }),
      signal: AbortSignal.any(
        signal ? [AbortSignal.timeout(VALIDATE_TIMEOUT_MS), signal] : [AbortSignal.timeout(VALIDATE_TIMEOUT_MS)],
      ),
    });
    if (!res.ok) {
      const reason = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) return { ok: false, kind: "invalid", reason };
      if (res.status === 429) return { ok: false, kind: "rate-limited", reason };
      return { ok: false, kind: "unreachable", reason };
    }
    const text = extractResultText(await res.text()); // throws on isError/error envelopes
    if (!text.trim()) return { ok: false, kind: "unreachable", reason: "empty response" };
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

type WizardPhase = "intro" | "paste" | "validating" | "save" | "done" | "error";

const closeKeys = (data: string): boolean =>
  matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));

export class ExaSetupWizard {
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly requestRender: () => void;

  private phase: WizardPhase = "intro";
  private key = "";
  private pasteError: string | null = null; // last validation failure, shown at Paste
  private pasteErrorKind: "invalid" | "rate-limited" | "unreachable" | null = null;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private validationAbort: AbortController | null = null;
  private saveResult: { error: string | null; path: string } | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: { theme: Theme; onClose: () => void; requestRender: () => void }) {
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRender = options.requestRender;
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
    this.go("paste");
  }

  private write(): void {
    const path = canonicalConfigPath();
    try {
      upsertExaKey(path, this.key.trim());
      resetExaKeyCache(); // lazy resolution: the next Exa call sees the new key
      this.saveResult = { error: null, path };
      this.go("done");
    } catch (err) {
      const reason = err instanceof Error && err.message
        ? redact(err.message, this.key)
        : String(err);
      this.saveResult = { error: reason, path };
      this.go("error");
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
    const wrap = (text: string, style: "text" | "dim" | "error" | "warning" = "text", indent = 0) => {
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
        add();
        wrap("A key is only needed when you hit an Exa rate limit or want its results — DuckDuckGo and the free fetch chain keep working either way.");
        add();
        wrap("Enter opens the Exa dashboard in your browser to create a key.");
        add();
        add(`  ${this.theme.fg("dim", DASHBOARD_URL)}`);
        break;
      }
      case "paste": {
        wrap("On the dashboard: API Keys → Create key → copy it.");
        add();
        add(`  ${this.theme.fg("dim", DASHBOARD_URL)}`);
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
        wrap("The exa server entry in your MCP config will become:");
        add();
        const preview = JSON.stringify(previewEntry(this.key.trim()), null, 2);
        for (const l of preview.split("\n")) {
          lines.push(`    ${this.theme.fg("text", truncateToWidth(l, W - 6, "…"))}`);
        }
        add();
        wrap(`Written to ${canonicalConfigPath()} — other servers and settings are left untouched.`, "dim");
        break;
      }
      case "done": {
        const path = this.saveResult?.path ?? canonicalConfigPath();
        add(`  ${this.theme.fg("accent", this.theme.bold("✓ Key saved"))}`);
        add();
        wrap(`Wrote ${path}. No restart needed — the next Exa call picks it up.`);
        add();
        wrap("DuckDuckGo search and the free fetch chain keep working either way.", "dim");
        break;
      }
      case "error": {
        const path = this.saveResult?.path ?? canonicalConfigPath();
        add(`  ${this.theme.fg("error", this.theme.bold("✗ Could not update the config"))}`);
        add();
        wrap(`${this.saveResult?.error ?? "unknown error"} — ${path} was not changed.`);
        add();
        wrap("To fix it by hand, set the exa server URL in your MCP config to:");
        add(`  ${this.theme.fg("dim", `${EXA_MCP_URL}?exaApiKey=<your-key>&tools=${EXA_TOOLS}`)}`);
        break;
      }
    }

    add();
    add(`  ${this.theme.fg("dim", footerFor(this.phase))}`);
    add(this.theme.fg("border", "─".repeat(W)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function footerFor(phase: WizardPhase): string {
  switch (phase) {
    case "intro": return "enter open dashboard · esc close, nothing changes";
    case "paste": return "enter validate · backspace edit · esc back";
    case "validating": return "esc cancel";
    case "save": return "enter write & finish · esc back";
    case "done": return "enter / q close";
    case "error": return "enter / q close";
  }
}

// The Save preview shows the exact entry upsert would produce, key masked.
function previewEntry(key: string): Record<string, unknown> {
  let configText: string | null = null;
  try {
    configText = readFileSync(canonicalConfigPath(), "utf-8");
  } catch {
    configText = null;
  }
  let entry: Record<string, unknown>;
  try {
    entry = withExaKey(configText, key).entry;
  } catch {
    entry = { type: "streamable-http", url: "" };
  }
  const previewed = { ...entry } as Record<string, unknown>;
  if (typeof previewed.url === "string") previewed.url = maskKeyInUrl(previewed.url);
  return previewed;
}

// ── Opening ──────────────────────────────────────────────────────────────────

let wizardOpen = false;

export function openExaSetup(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui") {
    // Headless: no takeover possible — print the manual path instead.
    ctx.ui.notify(
      `The Exa setup wizard needs TUI mode. To add the key by hand, put this in ${canonicalConfigPath()}:\n` +
      `  "exa": { "type": "streamable-http", "url": "${EXA_MCP_URL}?exaApiKey=<your-key>&tools=${EXA_TOOLS}" }\n` +
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
