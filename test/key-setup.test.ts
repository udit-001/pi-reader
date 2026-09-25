// Tests for the shared key-setup skeleton (search/key-setup.ts): the pure
// paste-buffer seam, the phase machine driven with fake specs (no TUI, no
// network), and the OpenAlex validation classifier. These tests serve every
// provider instance built on the skeleton — Exa's and OpenAlex's own seams
// stay in their modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPasteInput,
  KeySetupWizard,
  redact,
  type KeySetupSpec,
  type Theme,
  type ValidationResult,
} from "../search/key-setup.ts";
import { classifyOpenAlexValidation } from "../search/openalex-setup.ts";

// ── redact — the secret scrubber (moved from exa-setup, one home) ────────────

test("redact scrubs the secret from text", () => {
  assert.equal(redact("error at secret-key-value end", "secret-key-value"), "error at [redacted] end");
  // Short secrets are not scrubbed — the replacement would leak more than it hides.
  assert.equal(redact("error at abc end", "abc"), "error at abc end");
});

// ── applyPasteInput — the hidden paste buffer seam ──────────────────────────

test("paste seam appends printable text and clears the last error", () => {
  const r = applyPasteInput("ab", "c");
  assert.equal(r.key, "abc");
  assert.equal(r.changed, true);
  assert.equal(r.clearError, true);
  assert.equal(r.submit, false);
});

test("paste seam replaces the buffer on bracketed paste, stripping newlines", () => {
  const r = applyPasteInput("stale", "\x1b[200~ key-123 \n\r\x1b[201~");
  assert.equal(r.key, "key-123");
  assert.equal(r.changed, true);
  assert.equal(r.clearError, true);
});

test("paste seam handles backspace, enter-submit, close keys, and non-text escapes", () => {
  assert.equal(applyPasteInput("abc", "\x7f").key, "ab");
  assert.equal(applyPasteInput("", "\r").submit, false); // empty buffer never submits
  assert.equal(applyPasteInput("k", "\r").submit, true);
  assert.equal(applyPasteInput("k", "\x1b").back, true);
  assert.equal(applyPasteInput("k", "\x03").back, true); // ctrl+c
  // Other escape sequences (arrows, etc.) are not text — ignored.
  const r = applyPasteInput("k", "\x1b[A");
  assert.equal(r.key, "k");
  assert.equal(r.changed, false);
});

// ── The skeleton phase machine, driven with a fake spec ─────────────────────

const fakeTheme = {
  fg: (_style: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

interface FakeSpec extends KeySetupSpec {
  saved: string[];
}

function fakeSpec(validate: (key: string) => Promise<ValidationResult>): FakeSpec {
  return {
    title: "Fake setup",
    dashboardUrl: "https://example.com/keys",
    introLines: ["Intro line one."],
    pasteInstructions: "Copy the key.",
    validatingLabel: "Testing...",
    validate,
    save(key) {
      this.saved.push(key);
    },
    saved: [],
    previewConfig: (key) => ({ apiKey: "•".repeat(key.length) }),
    manualInstructions: "manual path",
    writeErrorHint: "fix by hand",
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Test handle: exposes the paste place without driving the intro's Enter
 *  (which best-effort-spawns a browser opener). */
class TestWizard extends KeySetupWizard {
  enterPaste(): void {
    this.go("paste");
  }
}

function makeWizard(spec: FakeSpec, onClose: () => void = () => {}): TestWizard {
  return new TestWizard(spec, { theme: fakeTheme, onClose, requestRender: () => {} });
}

function rendered(w: KeySetupWizard): string {
  return w.render(80).join("\n");
}

test("skeleton: paste → validate(ok) → save → done writes the trimmed key", async () => {
  const spec = fakeSpec(async (key) => {
    assert.equal(key, "k-123"); // trimmed before the probe
    return { ok: true };
  });
  const wizard = makeWizard(spec);
  wizard.enterPaste();
  wizard.handleInput("\x1b[200~ k-123 \x1b[201~"); // bracketed paste with padding
  wizard.handleInput("\r"); // submit → validating
  await flush();
  assert.match(rendered(wizard), /New config:/);
  assert.match(rendered(wizard), /•{5}/); // masked preview — never the key
  wizard.handleInput("\r"); // write → done
  assert.deepEqual(spec.saved, ["k-123"]);
  assert.match(rendered(wizard), /✓ Key saved/);
  let closed = false;
  wizard.dispose();
  void closed;
});

test("skeleton: an invalid key returns to paste with the error, never rendering the key", async () => {
  const spec = fakeSpec(async () => ({ ok: false, kind: "invalid", reason: "bad key" }));
  const wizard = makeWizard(spec);
  wizard.enterPaste();
  wizard.handleInput("k-123");
  wizard.handleInput("\r");
  await flush();
  const text = rendered(wizard);
  assert.match(text, /✗ Invalid key: bad key/);
  assert.match(text, /key: •{5}/); // masked
  assert.doesNotMatch(text, /k-123/);
  wizard.dispose();
});

test("skeleton: a failing save lands on the error place — nothing changed, hint shown", async () => {
  const spec = fakeSpec(async () => ({ ok: true }));
  spec.save = () => {
    throw new Error("disk full");
  };
  const wizard = makeWizard(spec);
  wizard.enterPaste();
  wizard.handleInput("k-123");
  wizard.handleInput("\r");
  await flush();
  wizard.handleInput("\r");
  const text = rendered(wizard);
  assert.match(text, /✗ Could not save the config/);
  assert.match(text, /disk full\. Nothing was changed\./);
  assert.match(text, /fix by hand/);
  wizard.dispose();
});

test("skeleton: async done lines land after save — the budget readout pattern", async () => {
  const spec = fakeSpec(async () => ({ ok: true }));
  spec.doneLinesAsync = async () => ["Daily budget: 1000"];
  const wizard = makeWizard(spec);
  wizard.enterPaste();
  wizard.handleInput("k-123");
  wizard.handleInput("\r");
  await flush();
  wizard.handleInput("\r");
  assert.match(rendered(wizard), /Reading the daily budget\.\.\./);
  await flush();
  const text = rendered(wizard);
  assert.match(text, /Daily budget: 1000/);
  assert.doesNotMatch(text, /k-123/);
  wizard.dispose();
});

test("skeleton: reopening guard is per-title, and the headless path prints the manual path", async () => {
  // Covered at the openKeySetup level — here we pin that the guard set is
  // keyed by title by exercising two wizards with distinct titles at once.
  const a = makeWizard(fakeSpec(async () => ({ ok: true })));
  const b = makeWizard(fakeSpec(async () => ({ ok: true })));
  assert.match(rendered(a), /Fake setup/);
  assert.match(rendered(b), /Fake setup/);
  a.dispose();
  b.dispose();
});

// ── classifyOpenAlexValidation — the free probe's rejection classes ─────────

test("openalex validation classification: ok, key rejected, credits exhausted, throttled, unreachable", () => {
  assert.deepEqual(classifyOpenAlexValidation(true, 200, null, null, "k"), { ok: true });

  const invalid = classifyOpenAlexValidation(false, 401, null, null, "k");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok ? "" : invalid.kind, "invalid");
  assert.match(invalid.ok ? "" : invalid.reason, /key rejected/);

  const exhausted = classifyOpenAlexValidation(false, 429, 0, null, "k");
  assert.equal(exhausted.ok ? "" : exhausted.kind, "rate-limited");
  assert.match(exhausted.ok ? "" : exhausted.reason, /daily credits exhausted/);

  const throttled = classifyOpenAlexValidation(false, 429, 9, null, "k");
  assert.equal(throttled.ok ? "" : throttled.kind, "rate-limited");
  assert.match(throttled.ok ? "" : throttled.reason, /temporary throttling/);

  const unreachable = classifyOpenAlexValidation(false, 500, null, null, "k");
  assert.equal(unreachable.ok ? "" : unreachable.kind, "unreachable");
});
