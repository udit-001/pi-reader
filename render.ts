// render.ts — transcript presentation for web_search.
//
// The module's interface is pi's renderer seam: `renderCall` and
// `renderResult`, attached to the web_search registration by spreading
// `webSearchRenderers` into it. The contract with `execute()` is the
// `WebSearchDetails` payload that tool already returns — this module reads
// that structured payload, never the text content, which stays aimed at the
// model. Collapsed: provider, count, top rows. Expanded: every row with its
// snippet. The TUI transcript changes; what the model sees does not.
//
// Internal seam: `searchView()` is pure — details + view options in, plain
// view model out — so collapsed/expanded/error shaping is testable with no
// theme, no TUI, and no live session. Theme colors, the Text component, and
// the lastComponent reuse live only in the callbacks.

import { Text } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

// ── Details contract (shared with execute()) ────────────────────────────────

export interface WebSearchDetailsRow {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  author?: string;
  /** Papers rows carry ~30 more fields; the renderer reads none of them. */
  [key: string]: unknown;
}

export interface WebSearchDetails {
  error?: string;
  provider?: string;
  resultCount?: number;
  nextCursor?: string;
  results?: WebSearchDetailsRow[];
}

// ── View model (pure — the testable seam) ───────────────────────────────────

/** Collapsed rows shown before the "…N more" hint — Radius's count. */
export const COLLAPSED_ROWS = 3;
/** Expanded snippet length — Radius's budget: enough to judge, not to read. */
export const SNIPPET_CHARS = 220;

export interface SearchRowView {
  index: number;
  title: string;
  url: string;
  publishedDate?: string;
  snippet?: string;
}

export interface SearchView {
  provider?: string;
  count: number;
  query: string;
  rows: SearchRowView[];
  hiddenCount: number;
  nextCursor?: string;
  error?: string;
}

export interface SearchViewOptions {
  expanded: boolean;
  query: string;
}

/** Shape details for the transcript. Collapsed caps at COLLAPSED_ROWS with no
 *  snippets; expanded shows every row with a whitespace-normalized snippet. */
export function searchView(
  details: WebSearchDetails | undefined,
  options: SearchViewOptions,
): SearchView {
  const rows = details?.results ?? [];
  const shown = options.expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  return {
    provider: details?.provider,
    count: details?.resultCount ?? rows.length,
    query: options.query,
    rows: shown.map((row, i) => ({
      index: i + 1,
      title: row.title || "(untitled)",
      url: row.url,
      ...(row.publishedDate ? { publishedDate: row.publishedDate } : {}),
      ...(options.expanded && row.snippet
        ? {
          snippet: row.snippet.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
        }
        : {}),
    })),
    hiddenCount: options.expanded ? 0 : Math.max(0, rows.length - COLLAPSED_ROWS),
    ...(details?.nextCursor ? { nextCursor: details.nextCursor } : {}),
    ...(details?.error ? { error: details.error } : {}),
  };
}

// ── Renderer callbacks (theme + TUI assembly only) ──────────────────────────

interface WebSearchCallArgs {
  query?: string;
  provider?: string;
  page?: number;
  recency?: string;
  numResults?: number;
}

export const webSearchRenderers: Pick<
  ToolDefinition<any, WebSearchDetails>,
  "renderCall" | "renderResult"
> = {
  renderCall(rawArgs, theme, context) {
    const args = (rawArgs ?? {}) as WebSearchCallArgs;
    const text =
      context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const parts = [theme.fg("toolTitle", theme.bold("search "))];
    parts.push(theme.fg("accent", `“${args.query ?? ""}”`));
    if (args.provider && args.provider !== "auto") parts.push(theme.fg("dim", ` ${args.provider}`));
    if (args.page && args.page > 1) parts.push(theme.fg("dim", ` page ${args.page}`));
    if (args.recency) parts.push(theme.fg("dim", ` ${args.recency}`));
    if (args.numResults) parts.push(theme.fg("dim", ` max=${args.numResults}`));
    text.setText(parts.join(""));
    return text;
  },

  renderResult(
    result: AgentToolResult<WebSearchDetails>,
    { expanded, isPartial }: ToolRenderResultOptions,
    theme: Theme,
    context,
  ) {
    const text =
      context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const contentText = result.content.find((item) => item.type === "text")?.text;
    if (isPartial) {
      text.setText(theme.fg("muted", contentText ?? ""));
      return text;
    }
    const details = result.details;
    if (details?.error) {
      text.setText(theme.fg("error", details.error || contentText || "Search failed"));
      return text;
    }
    if (!details) {
      // Sessions resumed across the renderer's introduction replay results
      // with no details payload — fall back to the text the tool returned.
      text.setText(theme.fg("muted", contentText ?? "No web search results"));
      return text;
    }
    const query = (context.args as WebSearchCallArgs | undefined)?.query ?? "";
    const view = searchView(details, { expanded, query });
    if (view.count === 0) {
      text.setText(theme.fg("muted", `No results for “${view.query}”`));
      return text;
    }
    const header: string[] = [];
    if (view.provider) header.push(theme.fg("dim", `${view.provider} ·`));
    header.push(theme.fg("success", `${view.count} result${view.count === 1 ? "" : "s"}`));
    header.push(theme.fg("dim", ` for “${view.query}”`));
    const lines = [header.join(" ")];
    for (const row of view.rows) {
      let line = `${theme.fg("muted", `${row.index}.`)} ${theme.fg("accent", row.title)}`;
      if (row.publishedDate) line += theme.fg("dim", ` — ${row.publishedDate}`);
      line += theme.fg("dim", ` — ${row.url}`);
      lines.push(line);
      if (row.snippet) lines.push(`   ${theme.fg("muted", row.snippet)}`);
    }
    if (view.hiddenCount > 0) {
      lines.push(theme.fg("dim", `…${view.hiddenCount} more`));
    }
    if (view.nextCursor) {
      lines.push(theme.fg("dim", `Next cursor: pass filters.cursor for the next page.`));
    }
    text.setText(lines.join("\n"));
    return text;
  },
};
