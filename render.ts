// render.ts — transcript presentation for web_search.
//
// The module's interface is pi's renderer seam: `renderCall` and
// `renderResult`, attached to the web_search registration by spreading
// `webSearchRenderers` into it. The contract with `execute()` is the
// `WebSearchDetails` payload that tool already returns — this module reads
// that structured payload, never the text content, which stays aimed at the
// model. Collapsed: provider, count, top rows. Expanded: every row with its
// snippet. People-category rows (Exa LinkedIn profiles) render through a
// dedicated `peopleView`: markdown heading markers from the scraped page are
// stripped, the name comes from the row title, and the full profile text is
// shown as-is — deliberately no field splitting, since profiles differ in
// what they carry. Collapsed caps at COLLAPSED_ROWS one-liners; expanded
// reveals every row's full text. The machine timestamp becomes a short
// relative date. The TUI transcript changes; what the model sees does not.
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
  /** Requested Exa category; only "people" changes the transcript view. */
  category?: string;
  results?: WebSearchDetailsRow[];
}

// ── View model (pure — the testable seam) ───────────────────────────────────

/** Collapsed rows shown before the "…N more" hint — Radius's count. */
export const COLLAPSED_ROWS = 3;
/** Expanded snippet length — Radius's budget: enough to judge, not to read. */
export const SNIPPET_CHARS = 220;
/** People profile text wraps at this width with a hanging indent; wider
 *  terminals keep the row's block shape, narrower ones fall back to the
 *  TUI's own full-width wrap. */
export const PEOPLE_WRAP_COLS = 96;

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

// ── People view (pure — the testable seam) ──────────────────────────────────

export interface PeopleRowView {
  index: number;
  name: string;
  /** The full scraped profile text, markdown heading markers stripped and
   *  pre-wrapped with a hanging indent — role, location, stats, and
   *  about-text exactly as the page carried them, never cut. */
  profile?: string[];
  url: string;
  /** Machine timestamp reformatted as a short relative date. */
  publishedDate?: string;
}

export interface PeopleView {
  provider?: string;
  count: number;
  query: string;
  rows: PeopleRowView[];
  hiddenCount: number;
  nextCursor?: string;
  error?: string;
}

export interface PeopleViewOptions {
  expanded: boolean;
  query: string;
  /** Clock for the relative date; tests pin it instead of Date.now(). */
  now?: number;
}

/** Strip the scraped page's markdown heading markers and collapse runs of
 *  whitespace. A heading marker only counts when it follows whitespace or the
 *  string start, so "C#" and "###"-shaped bios survive intact. */
function cleanScrapeText(text: string): string {
  return text
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Format a machine timestamp the way a person reads it: relative inside a
 *  month, otherwise a short date. Unparseable input returns undefined. */
function formatSearchDate(iso: string, now: number): string | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  const d = new Date(t);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const sameYear = new Date(now).getUTCFullYear() === d.getUTCFullYear();
  return sameYear ? `${month} ${d.getUTCDate()}` : `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Drop a display URL's scheme and www so a LinkedIn slug fits on one line. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

/** Parse one people-category row for display: the name comes from the row
 *  title, and the profile text is the scraped snippet with markdown heading
 *  markers stripped and the name prefix removed. Deliberately no field
 *  splitting — profiles differ in what they carry, so everything the scrape
 *  has is shown as-is, never re-shaped or dropped. When the source itself
 *  cut the text mid-word (Exa caps the scrape), a trailing … marks the cut
 *  as upstream so it doesn't read as the renderer trimming. */
function parsePeopleRow(row: WebSearchDetailsRow): { name: string; profile?: string; url: string } {
  const name = (row.title || "(untitled)").trim();
  let profile = cleanScrapeText(row.snippet ?? "");
  if (name !== "(untitled)" && profile.toLowerCase().startsWith(name.toLowerCase())) {
    profile = profile.slice(name.length).trim();
  }
  if (profile && /[A-Za-z0-9,;]$/.test(profile)) profile += "…";
  return {
    name,
    ...(profile ? { profile } : {}),
    url: row.url,
  };
}

/** Word-wrap `text` to `width` columns and prefix every line with `indent`,
 *  so a long paragraph keeps its hanging indent no matter how wide the
 *  paragraph runs. Terminals narrower than `width` re-wrap the TUI's way
 *  (flat, like today); wider ones keep the row's block shape. */
function wrapHanging(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word.length > width ? word.slice(0, width) : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l);
}

/** Shape people-category details for the transcript. Collapsed shows the top
 *  COLLAPSED_ROWS as one-liners (name, url, date — no profile text) with the
 *  hidden remainder counted; expanded shows every row with its full profile
 *  text. Nothing is ever cut mid-word: collapse hides, expand reveals all. */
export function peopleView(
  details: WebSearchDetails | undefined,
  options: PeopleViewOptions,
): PeopleView {
  const rows = details?.results ?? [];
  const now = options.now ?? Date.now();
  const shown = options.expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  return {
    provider: details?.provider,
    count: details?.resultCount ?? rows.length,
    query: options.query,
    rows: shown.map((row, i) => {
      const { profile, ...parsed } = parsePeopleRow(row);
      const profileLines = options.expanded && profile
        ? wrapHanging(profile, PEOPLE_WRAP_COLS, "   ")
        : undefined;
      return {
        index: i + 1,
        ...parsed,
        ...(row.publishedDate ? { publishedDate: formatSearchDate(row.publishedDate, now) } : {}),
        ...(profileLines ? { profile: profileLines } : {}),
      };
    }),
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
    if (details.category === "people") {
      const view = peopleView(details, { expanded, query });
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
        lines.push(`${theme.fg("muted", `${row.index}.`)} ${theme.fg("accent", row.name)}`);
        if (row.profile) lines.push(...row.profile);
        const meta = [shortUrl(row.url), ...(row.publishedDate ? [row.publishedDate] : [])].join(" · ");
        lines.push(`   ${theme.fg("dim", meta)}`);
      }
      if (view.hiddenCount > 0) {
        lines.push(theme.fg("dim", `…${view.hiddenCount} more`));
      }
      if (view.nextCursor) {
        lines.push(theme.fg("dim", `Next cursor: pass filters.cursor for the next page.`));
      }
      text.setText(lines.join("\n"));
      return text;
    }
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
