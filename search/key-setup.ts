// key-setup.ts — the shared key-setup wizard skeleton (PIWEB-22).
//
// A keyed provider's setup is the same conceptual flow wearing different
// copy: intro → dashboard → hidden paste (bracketed-paste handling, masking)
// → validate → save (masked preview, atomic write) → done, plus the spinner,
// the headless "print the manual path" fallback, secret redaction, and the
// reopen guard. This module owns all of that once; a provider's wizard is a
// spec (static copy + validate/save hooks) and — where it has extras — a
// thin subclass (Exa's mcp.json import and dedupe-removal places live there,
// never here).
//
// The key is never rendered: masked in previews, redacted from error text.

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { configPath } from "../config.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;
const WIZARD_WIDTH = 72;

// ── Masking / redaction ──────────────────────────────────────────────────────

/** Scrub a secret from text before it can reach an error surface. */
export function redact(text: string, secret: string): string {
  if (secret.length > 4) return text.split(secret).join("[redacted]");
  return text;
}

// ── Validation result — one shape for every keyed provider ──────────────────

export type ValidationOk = { ok: true };
export type ValidationFail =
  | { ok: false; kind: "invalid"; reason: string }
  | { ok: false; kind: "rate-limited"; reason: string }
  | { ok: false; kind: "unreachable"; reason: string };
export type ValidationResult = ValidationOk | ValidationFail;

// ── Pure seam: the hidden paste buffer ───────────────────────────────────────

/** What one input event does to the paste buffer. Pure; exported for tests —
 *  every provider's paste place rides this one implementation. */
export interface PasteOutcome {
  /** The next buffer value. */
  key: string;
  /** Buffer changed → re-render (and the cursor/length display updates). */
  changed: boolean;
  /** Clear the last validation error (fresh typing implies a fresh try). */
  clearError: boolean;
  /** Enter pressed with a non-empty buffer → run validation. */
  submit: boolean;
  /** Close keys (esc / ctrl+c) → back to intro. */
  back: boolean;
}

/** Apply one raw input event to the hidden key buffer: printable characters
 *  append, backspace deletes, bracketed paste (ESC[200~ … ESC[201~) replaces
 *  the buffer with its content minus newlines, enter submits a non-empty
 *  buffer, close keys request backing out, other escape sequences are not
 *  text and are ignored. Pure; exported for tests. */
export function applyPasteInput(current: string, data: string): PasteOutcome {
  const quiet: PasteOutcome = { key: current, changed: false, clearError: false, submit: false, back: false };
  if (matchesKey(data, Key.enter) || data === "\r") {
    return { ...quiet, submit: current.trim().length > 0 };
  }
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
    return { ...quiet, back: true };
  }
  if (matchesKey(data, Key.backspace) || data === "\x7f") {
    return { ...quiet, key: current.slice(0, -1), changed: true };
  }
  const bracketed = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(data);
  if (bracketed) {
    return { ...quiet, key: bracketed[1]!.replace(/[\r\n]/g, "").trim(), changed: true, clearError: true };
  }
  if (data.startsWith("\x1b")) return quiet; // other escape sequences aren't text
  if (/^[\x20-\x7e]+$/.test(data)) {
    return { ...quiet, key: current + data, changed: true, clearError: true };
  }
  return quiet;
}

// ── The spec — what makes a provider's wizard its own ────────────────────────

export interface KeySetupSpec {
  /** Wizard title, e.g. "Exa setup". Also the reopen-guard key. */
  title: string;
  /** The key-management page — opened best-effort on Enter, always shown as text. */
  dashboardUrl: string;
  /** Intro body: why the key matters, what keyless still gets. */
  introLines: string[];
  /** Where the current key lives ("config", "environment"); null → none. */
  currentKeyLabel?: () => string | null;
  /** Paste-place instruction (what to do on the dashboard). */
  pasteInstructions: string;
  /** Validating-place label, e.g. "Testing the key (one search)...". */
  validatingLabel: string;
  /** One cheap validation call through the same client the adapter uses. */
  validate: (key: string, signal?: AbortSignal) => Promise<ValidationResult>;
  /** Persist the trimmed key; throws on failure (→ error place, nothing changed). */
  save: (key: string) => void;
  /** The masked config object the save place previews. */
  previewConfig: (key: string) => unknown;
  /** Runs after a successful write (cache resets) — before the done place. */
  afterSave?: () => void;
  /** Extra done-screen lines (resolved synchronously). */
  doneLines?: () => string[];
  /** Extra done-screen lines fetched live (e.g. a budget readout). The done
   *  place renders a reading line until resolved, then re-renders. */
  doneLinesAsync?: () => Promise<string[]>;
  /** Headless fallback: the manual path (config shape + key URL). */
  manualInstructions: string;
  /** Error-place hint (env var name, config path, retry command). */
  writeErrorHint: string;
}

// ── The skeleton wizard ──────────────────────────────────────────────────────

export type WizardPhase = "intro" | "paste" | "validating" | "save" | "remove" | "done" | "error";

const closeKeys = (data: string): boolean =>
  matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));

/** The close-key grammar (esc / ctrl+c), shared with subclass phases. */
export function isCloseKey(data: string): boolean {
  return closeKeys(data);
}

/** The provider-neutral state machine and renderer. Subclasses add phases
 *  (Exa's remove) and dynamic copy by overriding the protected hooks; the
 *  flow itself lives here once. */
export class KeySetupWizard {
  protected readonly theme: Theme;
  protected readonly onClose: () => void;
  protected readonly requestRender: () => void;
  protected readonly spec: KeySetupSpec;

  protected phase: WizardPhase = "intro";
  protected key = "";
  protected pasteError: string | null = null; // last validation failure, shown at Paste
  protected pasteErrorKind: "invalid" | "rate-limited" | "unreachable" | null = null;
  protected wrote = false;
  protected writeError: string | null = null;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private validationAbort: AbortController | null = null;
  private doneExtraLines: string[] | null = null;
  private doneLinesPending = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(spec: KeySetupSpec, options: { theme: Theme; onClose: () => void; requestRender: () => void }) {
    this.spec = spec;
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
    if (this.handlePhaseInput(data)) return;
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
      default:
        return; // subclass-owned phases handle their own input
    }
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.requestRender();
  }

  // ── Protected hooks — the subclass extension points ────────────────────────

  /** First shot at every input event; true = handled. Subclass phases
   *  (import keys, remove) ride this. */
  protected handlePhaseInput(_data: string): boolean {
    return false;
  }

  /** Dynamic paste-place instruction (e.g. a re-entry prompt after an
   *  imported key was rejected). */
  protected pasteInstructions(): string {
    return this.spec.pasteInstructions;
  }

  /** True when the paste place should also show the dashboard URL. */
  protected showDashboardAtPaste(): boolean {
    return true;
  }

  /** Extra intro lines (an import offer, for instance). */
  protected introHintLines(): string[] {
    return [];
  }

  /** Footer segments for the intro place. */
  protected introFooter(_hasHint: boolean): string {
    return "enter open dashboard · esc close";
  }

  /** Render a phase the skeleton doesn't own; true = rendered. */
  protected renderPhase(_add: (s?: string) => void, _wrap: (text: string, style?: "text" | "dim" | "error" | "warning" | "accent", indent?: number) => void): boolean {
    return false;
  }

  /** Footer for a phase the skeleton doesn't own. */
  protected phaseFooter(_phase: WizardPhase): string | null {
    return null;
  }

  /** Runs after a successful write, before the done place — a subclass may
   *  divert to another phase (Exa's dedupe offer). */
  protected onSaved(): void {
    this.go("done");
  }

  /** Extra done-screen lines; subclasses append (removal outcomes). */
  protected doneLines(): string[] {
    return this.spec.doneLines?.() ?? [];
  }

  // ── Flow internals ─────────────────────────────────────────────────────────

  protected go(phase: WizardPhase): void {
    this.phase = phase;
    this.invalidate();
  }

  protected enterFromIntro(): void {
    openUrlBestEffort(this.spec.dashboardUrl);
    this.pasteError = null;
    this.pasteErrorKind = null;
    this.go("paste");
  }

  protected backToPaste(): void {
    this.go("paste");
  }

  protected handlePasteInput(data: string): void {
    const r = applyPasteInput(this.key, data);
    if (r.back) {
      this.go("intro");
      return;
    }
    this.key = r.key;
    if (r.clearError) {
      this.pasteError = null;
      this.pasteErrorKind = null;
    }
    if (r.changed) this.invalidate();
    if (r.submit) this.startValidation();
  }

  protected startValidation(): void {
    this.go("validating");
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, SPINNER_MS);
    this.validationAbort = new AbortController();
    const key = this.key.trim();
    void this.spec.validate(key, this.validationAbort.signal)
      .then((result) => {
        if (this.phase !== "validating") return; // cancelled meanwhile
        this.stopSpinner();
        if (result.ok) {
          this.key = key;
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

  protected cancelValidation(): void {
    this.stopSpinner();
    this.validationAbort?.abort();
    this.validationAbort = null;
    this.go("paste");
  }

  protected write(): void {
    try {
      this.spec.save(this.key.trim());
      this.spec.afterSave?.();
      this.wrote = true;
      this.writeError = null;
      this.startDoneLines();
      this.onSaved();
    } catch (err) {
      this.writeError = err instanceof Error && err.message
        ? redact(err.message, this.key)
        : String(err);
      this.go("error");
    }
  }

  /** Kick off the async done-screen fetch, if the spec has one; the done
   *  place re-renders when it lands. A failed readout is reported, never
   *  invented — the provider's hook handles its own error text. */
  private startDoneLines(): void {
    if (!this.spec.doneLinesAsync) return;
    this.doneLinesPending = true;
    this.doneExtraLines = null;
    void this.spec.doneLinesAsync()
      .then((lines) => {
        this.doneExtraLines = lines;
        this.doneLinesPending = false;
        this.invalidate();
      })
      .catch(() => {
        this.doneLinesPending = false;
        this.invalidate();
      });
  }

  protected stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

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
    add(`  ${this.theme.fg("accent", this.theme.bold(this.spec.title))}`);
    add();

    let handled = true;
    switch (this.phase) {
      case "intro": {
        for (const l of this.spec.introLines) wrap(l);
        add();
        const source = this.spec.currentKeyLabel?.() ?? null;
        wrap(source
          ? `Current key: set (${source})`
          : "Current key: none configured");
        add();
        wrap(`Get a key — Enter opens the dashboard.`);
        add();
        add(`  ${this.theme.fg("dim", this.spec.dashboardUrl)}`);
        for (const l of this.introHintLines()) {
          add();
          wrap(l, "accent");
        }
        break;
      }
      case "paste": {
        wrap(this.pasteInstructions());
        if (this.showDashboardAtPaste()) {
          add();
          add(`  ${this.theme.fg("dim", this.spec.dashboardUrl)}`);
        }
        add();
        if (this.pasteError) {
          const lead = this.pasteErrorKind === "rate-limited"
            ? "✗ Key is valid but rate-limited right now — saving it won't restore the full budget until it resets. "
            : this.pasteErrorKind === "unreachable"
              ? "✗ Could not check the key: "
              : "✗ Invalid key: ";
          wrap(`${lead}${this.pasteError}`, this.pasteErrorKind === "invalid" ? "error" : "warning");
          add();
        }
        wrap("Paste or type the key (hidden):");
        add();
        const masked = "•".repeat(Math.min(this.key.length, 24));
        const cursor = this.key.length > 0 || this.pasteError ? " " : "█";
        add(`  ${this.theme.fg("text", `key: ${masked}${cursor}`)}`);
        break;
      }
      case "validating": {
        const frame = SPINNER_FRAMES[this.spinnerFrame] ?? "⠋";
        add(`  ${this.theme.fg("accent", `${frame} ${this.spec.validatingLabel}`)}`);
        break;
      }
      case "save": {
        wrap("New config:", "text");
        add();
        const preview = JSON.stringify(this.spec.previewConfig(this.key.trim()), null, 2);
        for (const l of preview.split("\n")) {
          lines.push(`    ${this.theme.fg("text", truncateToWidth(l, W - 6, "…"))}`);
        }
        add();
        wrap(`Written to ${configPath()}. No restart needed.`, "dim");
        break;
      }
      case "done": {
        add(`  ${this.theme.fg("accent", this.theme.bold("✓ Key saved"))}`);
        add();
        wrap(`Written to ${configPath()}. No restart needed.`);
        const extra = this.doneExtraLines ?? (this.doneLinesPending ? ["Reading the daily budget..."] : []);
        for (const l of [...this.doneLines(), ...extra]) {
          add();
          wrap(l, "dim");
        }
        break;
      }
      case "error": {
        add(`  ${this.theme.fg("error", this.theme.bold("✗ Could not save the config"))}`);
        add();
        wrap(`${this.writeError ?? "unknown error"}. Nothing was changed.`);
        add();
        wrap(this.spec.writeErrorHint);
        break;
      }
      default:
        handled = this.renderPhase(add, wrap);
        break;
    }

    add();
    add(`  ${this.theme.fg("dim", this.footer())}`);
    add(this.theme.fg("border", "─".repeat(W)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private footer(): string {
    const custom = this.phaseFooter(this.phase);
    if (custom !== null) return custom;
    switch (this.phase) {
      case "intro": return this.introFooter(this.introHintLines().length > 0);
      case "paste": return "enter validate · backspace edit · esc back";
      case "validating": return "esc cancel";
      case "save": return "enter write & finish · esc back";
      case "done": return "enter / q close";
      case "error": return "enter / q close";
      default: return "esc close";
    }
  }
}
// ── Opening ──────────────────────────────────────────────────────────────────

/** Wizards currently open, keyed by title — one reopen guard for every
 *  provider's command. */
const openWizards = new Set<string>();

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

/** Open a provider's setup wizard: headless prints the manual path, the
 *  reopen guard de-dupes, TUI mode runs the skeleton in a custom component.
 *  `create` receives the TUI wiring (theme, close callback, render pump) so
 *  a provider can construct its subclass with extras. */
export function openKeySetup(
  ctx: ExtensionCommandContext,
  spec: KeySetupSpec,
  create: (wiring: { theme: Theme; onClose: () => void; requestRender: () => void }) => KeySetupWizard,
): void {
  if (ctx.mode !== "tui") {
    // Headless: no takeover possible — print the manual path instead.
    ctx.ui.notify(spec.manualInstructions, "info");
    return;
  }
  if (openWizards.has(spec.title)) {
    ctx.ui.notify(`The ${spec.title} wizard is already open.`, "info");
    return;
  }
  openWizards.add(spec.title);

  let instance: KeySetupWizard | undefined;
  void ctx.ui
    .custom<void>((tui, theme, _keybindings, done) => {
      instance = create({ theme, onClose: () => done(undefined), requestRender: () => tui.requestRender() });
      return {
        render(width: number) {
          return instance?.render(width) ?? [];
        },
        invalidate() {
          instance?.invalidate();
        },
        handleInput(data: string) {
          instance?.handleInput(data);
          tui.requestRender();
        },
      };
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to open the ${spec.title} wizard: ${message}`, "error");
    })
    .finally(() => {
      instance?.dispose();
      openWizards.delete(spec.title);
    });
}
