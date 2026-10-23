// setup-menu.ts — the common key-setup command (/search-setup).
//
// One door to all three keyed-provider wizards, the way pi's /mcp manager is
// the one door to its per-server parts. One overlay (ctx.ui.custom) hosts two
// places: the provider menu and the wizard itself. Enter swaps to the wizard
// (its own frame, phases, import extras — the skeleton, untouched); the
// wizard's close returns to the menu with statuses re-read, so a save is
// visible without reopening anything. Esc backs out one level; esc on the
// menu closes.
//
// What the menu owns — and the only things it decides:
//   • the arg preselect ("/search-setup exa") — how "which provider is rate
//     limited" reaches the menu, the one state the menu holds.
//   • the headless fallback — print every provider's manual path from the
//     wizard specs, so /search-setup works where no TUI takeover can.
//   • the mutual-exclusion rule with the wizard commands: one setup surface
//     at a time, shared registry with key-setup's reopen guard.
// Everything else is read from the four wizard specs — labels, dashboard
// URLs, save targets — so a spec change updates its row without an edit here.

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { SelectList, wrapTextWithAnsi, type SelectListTheme } from "@earendil-works/pi-tui";
import { KeySetupWizard, setWizardOpen, anyWizardOpen, type KeySetupSpec } from "./key-setup.ts";
import { ExaSetupWizard, exaSpec } from "./exa-setup.ts";
import { parallelSpec } from "./parallel-setup.ts";
import { openalexSpec } from "./openalex-setup.ts";
import { loadConfig, type PiWebConfig } from "../config.ts";

const MENU_TITLE = "Search setup";

// The registry — one entry per keyed provider 
export type SetupEntryId = "exa" | "parallel" | "openalex";

interface SetupEntry {
  id: SetupEntryId;
  /** Menu row label — the spec's own vocabulary. */
  label: string;
  /** The wizard spec — dashboardUrl and manual text reused verbatim. */
  spec: KeySetupSpec;
  /** Wizard construction; Exa's subclass brings the mcp.json import extras. */
  create: (wiring: { theme: Theme; onClose: () => void; requestRender: () => void }) => KeySetupWizard;
}

const ENTRIES: SetupEntry[] = [
  { id: "exa", label: exaSpec.title.replace(/ setup$/, ""), spec: exaSpec, create: (w) => new ExaSetupWizard(exaSpec, w) },
  { id: "parallel", label: parallelSpec.title.replace(/ setup$/, ""), spec: parallelSpec, create: (w) => new KeySetupWizard(parallelSpec, w) },
  { id: "openalex", label: openalexSpec.title.replace(/ setup$/, ""), spec: openalexSpec, create: (w) => new KeySetupWizard(openalexSpec, w) },
];

// Pure seams (the test surface) 
/** The command argument → entry id, or undefined for none / unknown. Pure —
 *  the notify for an unknown name lives at the opener, which knows the mode. */
export function parseSetupProvider(args: string): SetupEntryId | undefined {
  const name = args.trim().toLowerCase().replace(/^\//, "");
  return ENTRIES.some((e) => e.id === name) ? (name as SetupEntryId) : undefined;
}

/** The three statuses from the sources each wizard's intro already reads:
 *  config field first, env var second, none otherwise. Config keys are the
 *  specs' save() targets (exa.apiKey, parallel.apiKey, papers.openalexApiKey)
 *  restated here — one comment pins the coupling; a save-shape change in a
 *  spec turns this row off until it is updated. Pure; exported for tests. */
export function menuStatuses(
  cfg: Pick<PiWebConfig, "exa" | "parallel" | "papers"> | null,
  env: Record<string, string | undefined>,
): Record<SetupEntryId, string> {
  const configured = (v: string | undefined): boolean => typeof v === "string" && v.trim() !== "";
  const fromEnv = (k: string): boolean => typeof env[k] === "string" && env[k] !== "";
  const one = (cfgVal: string | undefined, envKey: string): string =>
    configured(cfgVal) ? "set (config)" : fromEnv(envKey) ? "set (environment)" : "none configured";
  return {
    exa: one(cfg?.exa?.apiKey, "EXA_API_KEY"),
    parallel: one(cfg?.parallel?.apiKey, "PARALLEL_API_KEY"),
    openalex: one(cfg?.papers?.openalexApiKey, "OPENALEX_API_KEY"),
  };
}

/** The menu rows. Unstyled here (SelectList owns row chrome); the label's
 *  trailing mark carries the set/unset distinction:
 *    "Exa ✓" when the key reads from config or env, plain "Parallel" when
 *  none is configured. The mark is text, not ANSI, so the SelectList's own
 *  theming (selected/unselected) still applies around it. Pure; tests pin
 *  the rule. */
export function menuRows(statuses: Record<SetupEntryId, string>) {
  return ENTRIES.map((e) => ({
    value: e.id,
    label: e.label + (statuses[e.id] === "none configured" ? "" : " ✓"),
    description: `key: ${statuses[e.id]} — ${e.spec.dashboardUrl}`,
  }));
}

/** The footer verb for the selected row: a set key gets replaced, a missing
 *  one gets set up. Pure; exported for tests. */
export function footerFor(status: string): string {
  const verb = status === "none configured" ? "enter set up" : "enter replace key";
  return `${verb} · esc close`;
}

// The hosting view 
/** The two places the overlay shows, in one component: the menu and the
 *  embedded wizard. SelectList owns the rows; the wizard owns everything
 *  else, unchanged. */
class SetupMenuView {
  private readonly theme: Theme;
  private readonly close: () => void;
  private readonly requestRender: () => void;
  private place: "menu" | "wizard" = "menu";
  private selectedIndex = 0; // the menu's one piece of state (arg preselect)
  private statuses: Record<SetupEntryId, string> | null = null;
  private list: SelectList | null = null;
  private wizard: KeySetupWizard | null = null;

  constructor(theme: Theme, start: number, close: () => void, requestRender: () => void) {
    this.theme = theme;
    this.close = close;
    this.requestRender = requestRender;
    this.selectedIndex = Math.max(0, Math.min(start, ENTRIES.length - 1));
    this.openMenu();
  }

  dispose(): void {
    this.wizard?.dispose();
    this.wizard = null;
  }

  invalidate(): void {
    this.list?.invalidate();
    this.wizard?.invalidate();
  }

  handleInput(data: string): void {
    if (this.place === "wizard" && this.wizard) {
      this.wizard.handleInput(data);
      return;
    }
    this.list?.handleInput(data);
  }

  render(width: number): string[] {
    if (this.place === "wizard" && this.wizard) return this.wizard.render(width);
    return this.renderMenu(width);
  }

  /** Build/rebuild the menu place: statuses re-read live, selection kept. */
  private openMenu(): void {
    const listTheme: SelectListTheme = {
      selectedPrefix: (t) => this.theme.fg("accent", t),
      selectedText: (t) => this.theme.fg("accent", t),
      description: (t) => this.theme.fg("dim", t),
      scrollInfo: (t) => this.theme.fg("dim", t),
      noMatch: (t) => this.theme.fg("dim", t),
    };
    const list = new SelectList(
      menuRows(menuStatuses(loadConfig(), process.env)),
      ENTRIES.length,
      listTheme,
    );
    this.statuses = menuStatuses(loadConfig(), process.env);
    list.setSelectedIndex(this.selectedIndex);
    list.onSelectionChange = (item) => {
      const at = ENTRIES.findIndex((e) => e.id === item.value);
      if (at !== -1) {
        this.selectedIndex = at;
        this.requestRender(); // footer verb follows the selection
      }
    };
    list.onSelect = (item) => this.enterWizard(item.value);
    list.onCancel = () => this.close();
    this.wizard?.dispose();
    this.wizard = null;
    this.place = "menu";
    this.list = list;
  }

  private enterWizard(id: string): void {
    const entry = ENTRIES.find((e) => e.id === id);
    if (!entry) return;
    this.selectedIndex = ENTRIES.findIndex((e) => e.id === id);
    this.list = null;
    this.wizard = entry.create({
      theme: this.theme,
      onClose: () => this.openMenu(), // done / esc from the wizard → back here
      requestRender: this.requestRender,
    });
    this.place = "wizard";
  }

  private renderMenu(width: number): string[] {
    // /mcp-style frame: DynamicBorder at full render width, no cap. The
    // explicit color fn avoids the jiti global-theme caveat pi warns about.
    const border = new DynamicBorder((t) => this.theme.fg("border", t));
    const lines: string[] = [];
    lines.push(...border.render(width));
    lines.push(`  ${this.theme.fg("accent", this.theme.bold(MENU_TITLE))}`);
    lines.push("");
    lines.push(...wrapLines("Search providers: add or replace keys. OpenAlex and Parallel work without one; limits vary.", this.theme, width));
    lines.push("");
    const listW = Math.max(20, width - 6);
    for (const l of this.list?.render(listW) ?? []) lines.push(`    ${l}`);
    lines.push("");
    lines.push(...wrapLines("DuckDuckGo works without a key.", this.theme, width, "dim"));
    lines.push("");
    lines.push(`  ${this.theme.fg("dim", "up/down choose · " + (this.statuses ? footerFor(this.statuses[ENTRIES[this.selectedIndex]!.id]) : "esc close"))}`);
    lines.push(...border.render(width));
    return lines;
  }
}

/** Wrap one line to the menu width in one style. */
function wrapLines(text: string, theme: Theme, W: number, style: "text" | "dim" = "text"): string[] {
  const pad = "  ";
  return wrapTextWithAnsi(text, Math.max(10, W - pad.length)).map((l) => `${pad}${theme.fg(style, l)}`);
}

/** Headless fallback: every provider's manual path, taken verbatim from the
 *  wizard specs — the same text /exa-setup would print in headless mode. */
function headlessBody(): string {
  return [
    `${MENU_TITLE} — key setup for pi-reader's search providers.`,
    "The guided wizards need TUI mode; manual paths for all three:",
    "",
    ...ENTRIES.flatMap((e, i) => (i > 0 ? [""] : []).concat([e.spec.manualInstructions])),
  ].join("\n");
}

// The opener — the module's whole interface 
/** Open /search-setup: TUI mode runs the hosting view with the arg's provider
 *  preselected; headless prints the manual paths; any already-open setup
 *  surface (wizard commands included) declines instead of stacking. */
export function openSearchSetup(ctx: ExtensionCommandContext, args: string): void {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(headlessBody(), "info");
    return;
  }
  const preselect = parseSetupProvider(args);
  if (preselect === undefined && args.trim() !== "") {
    ctx.ui.notify(`No setup for "${args.trim()}" — providers: exa, parallel, openalex.`, "info");
  }
  const open = anyWizardOpen();
  if (open) {
    ctx.ui.notify(`The ${open} view is already open.`, "info");
    return;
  }
  const start = preselect ? ENTRIES.findIndex((e) => e.id === preselect) : 0;
  setWizardOpen(MENU_TITLE, true);
  void ctx.ui
    .custom<void>((tui, theme, _keybindings, done) => {
      const view = new SetupMenuView(theme, start, () => done(undefined), () => tui.requestRender());
      return {
        render(width: number) {
          return view.render(width);
        },
        invalidate() {
          view.invalidate();
        },
        handleInput(data: string) {
          view.handleInput(data);
          tui.requestRender();
        },
      };
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to open ${MENU_TITLE}: ${message}`, "error");
    })
    .finally(() => {
      setWizardOpen(MENU_TITLE, false);
    });
}

/** Wire the /search-setup command. Registered beside the three wizard
 *  commands (index.ts); the arg preselects the provider row. */
export function registerSearchSetupCommand(pi: ExtensionAPI): void {
  pi.registerCommand("search-setup", {
    description: "Set up Exa, Parallel, or OpenAlex keys from one menu (guided wizards)",
    getArgumentCompletions: (prefix) =>
      ENTRIES.filter((e) => e.id.startsWith(prefix.trim().toLowerCase()))
        .map((e) => ({ value: e.id, label: e.label })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      openSearchSetup(ctx, args);
    },
  });
}
