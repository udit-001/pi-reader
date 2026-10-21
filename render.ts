// render.ts — transcript presentation for web_search and web_fetch.
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
// relative date. Papers-provider rows render through a dedicated
// `papersView`: the row's snippet is already the composed ranking line
// (venue · year · citations · badges — one shape, every backend), so the
// view reads it rather than re-composing it, appends the fwci the snippet
// deliberately omits, and — expanded — adds the resolvable link (OA URL or
// doi.org), the citation trend, and the abstract excerpt. Collapsed keeps
// the summary line and hides the rest; expand reveals all. The openai
// provider adds one more object: its answer is
// model-authored prose, so it rides in details and renders as a muted prose
// block under the header — markdown markers stripped, preview-trimmed when
// collapsed, full when expanded. Other providers' answers are
// buildAnswer(rows), a view of the rows themselves, and never ride in
// details. Citation rows whose only title is the URL render that URL once,
// shortened. web_fetch renders through the same shape: fetchView() caps
// pages to one-liners (title, link, size — failed pages show their error
// instead), expanded adds a bounded content preview, and a model-authored
// summary (the prompt param) rides in details like the openai answer does.
// All prose blocks — answers, profiles, previews, summaries — wrap at paint
// time (PreviewText, pi-subagents' render-override pattern): the terminal's
// width arrives only there, so blocks flow at message width. The TUI
// transcript changes; what the model sees does not.
//
// Internal seam: `searchView()` and friends are pure — details + view
// options in, plain view model out — so collapsed/expanded/error shaping is
// testable with no theme, no TUI, and no live session. Theme colors, the
// Text/PreviewText components, and the lastComponent reuse live only in the
// callbacks.

import {
  Text,
  hyperlink,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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
  /** Papers rows carry ~30 more fields; `papersView` reads the human-ranking
   *  ones (fwci, doi, oaUrl, trend, abstract) — the rest stay model-only. */
  [key: string]: unknown;
}

export interface WebSearchDetails {
  error?: string;
  provider?: string;
  resultCount?: number;
  nextCursor?: string;
  /** Requested Exa category; only "people" changes the transcript view. */
  category?: string;
  // Only provider "papers" and category "people" switch the transcript view.
  /** The openai provider's model-authored answer — the only provider whose
   *  answer is prose rather than a rendering of the rows. */
  answer?: string;
  results?: WebSearchDetailsRow[];
}

// ── View model (pure — the testable seam) ───────────────────────────────────

/** Collapsed rows shown before the "…N more" hint — Radius's count. */
export const COLLAPSED_ROWS = 3;
/** Expanded snippet length — Radius's budget: enough to judge, not to read. */
export const SNIPPET_CHARS = 220;
/** Collapsed preview budget for model-authored prose — openai answers, fetch
 *  summaries: enough to judge whether it's on track, not to read it; expand
 *  for the whole thing. */
export const PROSE_PREVIEW_CHARS = 240;
/** Expanded page-content preview — enough to recognize what arrived, not to
 *  read it; the full content went to the model. */
export const FETCH_PREVIEW_CHARS = 360;

export interface SearchRowView {
  index: number;
  title: string;
  url: string;
  /** The row had no real title — the title IS the URL, shortened; it renders
   *  once, as the link itself. */
  titleIsUrl: boolean;
  publishedDate?: string;
  snippet?: string;
}

export interface SearchView {
  provider?: string;
  count: number;
  query: string;
  /** Model-authored answer (openai only), markdown markers stripped; raw —
   *  collapsed carries a trimmed preview, expanded the whole prose. Wrapped
   *  at paint time by the width-aware component. */
  answer?: string;
  rows: SearchRowView[];
  hiddenCount: number;
  nextCursor?: string;
  error?: string;
}

export interface ViewOptions {
  expanded: boolean;
  query: string;
}

export type SearchViewOptions = ViewOptions;

/** Shape details for the transcript. Collapsed caps at COLLAPSED_ROWS with no
 *  snippets; expanded shows every row with a whitespace-normalized snippet.
 *  A model-authored answer, when present, is markdown-stripped, then
 *  preview-trimmed collapsed and full expanded — always pre-wrapped with a
 *  hanging indent so the block keeps its shape on wrap. */
export function searchView(
  details: WebSearchDetails | undefined,
  options: SearchViewOptions,
): SearchView {
  const rows = details?.results ?? [];
  const shown = options.expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  const answer = details?.answer ? cleanProse(details.answer) : undefined;
  return {
    provider: details?.provider,
    count: details?.resultCount ?? rows.length,
    query: options.query,
    ...(answer
      ? {
        // Collapsed cuts by visible width — embedded hyperlink escapes count
        // zero, and the … lands only when something was actually cut.
        answer: options.expanded ? answer : cutPlain(answer, PROSE_PREVIEW_CHARS),
      }
      : {}),
    rows: shown.map((row, i) => {
      // Untitled citations carry the URL as the title; show it once,
      // shortened, as the link itself instead of `url — url`.
      const urlTitle = /^https?:\/\//i.test(row.title);
      return {
        index: i + 1,
        title: urlTitle ? shortUrl(row.title) : row.title || "(untitled)",
        titleIsUrl: urlTitle,
        url: row.url,
        ...(row.publishedDate ? { publishedDate: row.publishedDate } : {}),
        ...(options.expanded && row.snippet
          ? {
            // Same markdown cleanup the answer gets — snippets cut from
            // LLM prose carry the same **bold** artifacts — and the same
            // visible-width cut, marked only when something was cut.
            snippet: cutPlain(cleanProse(row.snippet), SNIPPET_CHARS),
          }
          : {}),
      };
    }),
    hiddenCount: options.expanded ? 0 : Math.max(0, rows.length - COLLAPSED_ROWS),
    ...(details?.nextCursor ? { nextCursor: details.nextCursor } : {}),
    ...(details?.error ? { error: details.error } : {}),
  };
}

// ── People view (pure — the testable seam) ──────────────────────────────────

export interface PeopleRowView {
  index: number;
  name: string;
  /** The full scraped profile text, markdown heading markers stripped —
   *  role, location, stats, and about-text exactly as the page carried them,
   *  never cut. Raw — wrapped at paint time by the width-aware component. */
  profile?: string;
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

export interface PeopleViewOptions extends ViewOptions {
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

/** Strip the markdown an LLM-authored answer carries for a chat surface —
 *  bold/italic and inline-code markers drop — then collapse runs of
 *  whitespace. Links become real OSC 8 hyperlinks: the label stays short,
 *  the terminal gets the full clickable target. */
function cleanProse(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, label: string, url: string) => hyperlink(label, url))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
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
/** Display form of a URL: scheme and www stripped, query and fragment
 *  dropped (a load.php?lang=en&modules=... asset URL would wrap a whole row),
 *  and anything still over budget middle-ellipsized — host head kept, file
 *  tail kept. The href always carries the full URL; only the label shrinks. */
const SHORT_URL_MAX = 48;
export function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "");
  if (bare.length <= SHORT_URL_MAX) return bare;
  const head = bare.slice(0, SHORT_URL_MAX - 14);
  const tail = bare.slice(-10);
  return `${head}…${tail}`;
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

/** Cut plain prose at a visible-width budget with an ellipsis marker.
 *  truncateToWidth injects `\x1b[0m` before the ellipsis on every cut — even
 *  for plain input — and when the cut lands inside a styled, wrapped block,
 *  that reset also kills the block background, so the ellipsis and the row's
 *  trailing padding paint terminal-default black. Cutting plain text here
 *  (escapes stripped first, then the truncation's resets removed) keeps every
 *  emitted line a single clean style run. */
export function cutPlain(text: string, max: number): string {
  const cut = truncateToWidth(stripTerminalSequences(text), max, "…");
  return cut.replace(/\x1b\[0m/g, "");
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
      const profileText = options.expanded && profile ? profile : undefined;
      return {
        index: i + 1,
        ...parsed,
        ...(row.publishedDate ? { publishedDate: formatSearchDate(row.publishedDate, now) } : {}),
        ...(profileText ? { profile: profileText } : {}),
      };
    }),
    hiddenCount: options.expanded ? 0 : Math.max(0, rows.length - COLLAPSED_ROWS),
    ...(details?.nextCursor ? { nextCursor: details.nextCursor } : {}),
    ...(details?.error ? { error: details.error } : {}),
  };
}

// ── Papers view (pure — the testable seam) ───────────────────────────────

export interface PapersRowView {
  index: number;
  title: string;
  url: string;
  /** The backend-composed ranking line — venue · year · citations · OA and
   *  retracted badges — read as the row's snippet delivered it, with the
   *  fwci the snippet deliberately omits appended. Never re-composed here:
   *  one snippet shape, wherever the record came from. */
  summary?: string;
  /** Expanded only: the resolvable link target — the OA URL when the work
   *  is open, else doi.org, else the row's canonical URL. Always present:
   *  `url` is required data, so a link always renders. */
  linkTarget: string;
  /** Expanded only: citations over the last 3 complete years and, when the
   *  index states it, their direction — "96 recent (rising)". */
  trend?: string;
  /** Expanded only: the abstract, prose-cleaned and capped at the generic
   *  view's SNIPPET_CHARS budget, the cap marked. */
  abstract?: string;
}

export interface PapersView {
  provider?: string;
  count: number;
  query: string;
  rows: PapersRowView[];
  hiddenCount: number;
  nextCursor?: string;
  error?: string;
}

export type PapersViewOptions = ViewOptions;

/** Typed read off a details row's open index signature. Absent, null, and
 *  false all read as absent — a flag the index never asserted is never
 *  shown, so `retracted: false` renders exactly like no field at all. */
function paperField<T>(row: WebSearchDetailsRow, key: string): T | undefined {
  const v = row[key];
  return v === undefined || v === null || v === false ? undefined : (v as T);
}

/** Parse one papers row for display. The snippet is the ranking line and
 *  passes through cleaned but whole; the view adds only what the snippet
 *  deliberately omits — fwci, the resolvable link, the citation trend.
 *  The abstract stays model-grade bulk: carried raw for papersView to cap
 *  expanded, never re-shaped. */
function parsePaperRow(row: WebSearchDetailsRow): Omit<PapersRowView, "index"> & { abstract?: string } {
  const title = (row.title || "(untitled)").trim();
  const summaryParts: string[] = [];
  const snippet = cleanScrapeText(row.snippet ?? "");
  if (snippet) summaryParts.push(snippet);
  const fwci = paperField<number>(row, "fwci");
  if (fwci !== undefined) summaryParts.push(`fwci ${fwci.toFixed(1)}`);
  const doi = paperField<string>(row, "doi");
  const linkTarget = paperField<string>(row, "oaUrl")
    ?? (doi ? `https://doi.org/${doi}` : undefined)
    ?? row.url;
  const recent = paperField<number>(row, "recentCitations");
  const direction = paperField<string>(row, "citationTrend");
  const trend = recent !== undefined || direction !== undefined
    ? [
      ...(recent !== undefined ? [`${recent} recent`] : []),
      ...(direction ? [`(${direction})`] : []),
    ].join(" ")
    : undefined;
  const abstract = paperField<string>(row, "abstract");
  return {
    title,
    url: row.url,
    linkTarget,
    ...(summaryParts.length ? { summary: summaryParts.join(" · ") } : {}),
    ...(trend ? { trend } : {}),
    ...(abstract ? { abstract } : {}),
  };
}

/** Shape papers-provider details for the transcript. Collapsed keeps the
 *  ranking line (title + summary) for the top COLLAPSED_ROWS and counts the
 *  hidden remainder; expanded adds each row's link, trend, and abstract
 *  excerpt. Collapse hides, expand reveals — nothing is cut mid-word except
 *  the abstract, capped at the generic snippet's budget with the cap
 *  marked. */
export function papersView(
  details: WebSearchDetails | undefined,
  options: PapersViewOptions,
): PapersView {
  const rows = details?.results ?? [];
  const shown = options.expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  return {
    provider: details?.provider,
    count: details?.resultCount ?? rows.length,
    query: options.query,
    rows: shown.map((row, i) => {
      // linkTarget rides in base: required data, the renderer decides when
      // it displays. The trend and abstract collapse away.
      const { abstract, trend, ...base } = parsePaperRow(row);
      const excerpt = options.expanded && abstract
        ? cutPlain(cleanProse(abstract), SNIPPET_CHARS)
        : undefined;
      return {
        ...base,
        index: i + 1,
        ...(options.expanded && trend ? { trend } : {}),
        ...(excerpt ? { abstract: excerpt } : {}),
      };
    }),
    hiddenCount: options.expanded ? 0 : Math.max(0, rows.length - COLLAPSED_ROWS),
    ...(details?.nextCursor ? { nextCursor: details.nextCursor } : {}),
    ...(details?.error ? { error: details.error } : {}),
  };
}

// ── Fetch view (pure — the testable seam) ────────────────────────────────

/** The details payload web_fetch's execute() returns. Content is the page's
 *  markdown (or raw body) — agent food; the transcript shows a bounded
 *  preview. A model-authored summary (the prompt param) is a distinct object
 *  and rides in details like the openai answer does. */
export interface FetchDetails {
  error?: string;
  results?: Array<{
    url: string;
    title: string;
    content: string;
    error: string | null;
  }>;
  summarized?: boolean;
  model?: string;
  summary?: string;
}

export interface FetchRowView {
  index: number;
  title: string;
  url: string;
  /** Content size in characters — how much arrived. */
  chars: number;
  error?: string;
  /** Raw flattened content preview — the width-aware component wraps it at
   *  paint time; this seam stays width-blind. */
  preview?: string;
}

export interface FetchView {
  count: number;
  summarized?: boolean;
  model?: string;
  /** Model-authored summary, cleaned; collapsed carries the trimmed preview,
   *  expanded the whole thing. Raw — wrapped at paint time. */
  summary?: string;
  rows: FetchRowView[];
  hiddenCount: number;
  error?: string;
}

export interface FetchViewOptions {
  expanded: boolean;
}

/** Human-sized content count: "850 chars", "12.3k chars". Pure; exported for tests. */
export function formatChars(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`;
}

/** Shape fetch details for the transcript. Collapsed caps at COLLAPSED_ROWS
 *  one-liners (title, link, size — no content); expanded adds a flattened
 *  content preview per page, cut at FETCH_PREVIEW_CHARS. A failed page
 *  carries its error instead of a size or preview. */
export function fetchView(details: FetchDetails | undefined, options: FetchViewOptions): FetchView {
  const rows = details?.results ?? [];
  const shown = options.expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  const summary = details?.summary ? cleanProse(details.summary) : undefined;
  return {
    count: rows.length,
    ...(details?.summarized ? { summarized: true } : {}),
    ...(details?.model ? { model: details.model } : {}),
    ...(summary
      ? {
        summary: options.expanded ? summary : cutPlain(summary, PROSE_PREVIEW_CHARS),
      }
      : {}),
    rows: shown.map((row, i) => {
      const failed = !!row.error;
      return {
        index: i + 1,
        title: row.title || shortUrl(row.url),
        url: row.url,
        chars: row.content.length,
        ...(failed ? { error: row.error! } : {}),
        ...(options.expanded && !failed && row.content
          ? { preview: cutPlain(row.content.replace(/\s+/g, " ").trim(), FETCH_PREVIEW_CHARS) }
          : {}),
      };
    }),
    hiddenCount: options.expanded ? 0 : Math.max(0, rows.length - COLLAPSED_ROWS),
    ...(details?.error ? { error: details.error } : {}),
  };
}

// ── Width-aware preview component ───────────────────────────────────────

/** The terminal's real width only arrives at paint time (Component.render).
 *  Preview blocks wrap there, flowing at message width: `terminalWidth − 6`,
 *  floored so a squeezed terminal still renders usable lines. Via the
 *  pi-subagents render-override pattern. */
export const PREVIEW_MIN_COLS = 40;

export function previewWrapWidth(terminalWidth: number): number {
  return Math.max(PREVIEW_MIN_COLS, terminalWidth - 6);
}

const PREVIEW_INDENT = "   ";

type PreviewSegment =
  | { kind: "line"; text: string }
  | { kind: "block"; text: string; style: (s: string) => string };

/** Result text for fetch-shaped tools: final styled lines plus raw blocks
 *  that wrap at paint time. Every emitted line is one complete style run —
 *  the black-band lesson holds at any width. */
export class PreviewText {
  private segments: PreviewSegment[] = [];
  private cached?: { width: number; lines: string[] };

  set(segments: PreviewSegment[]): void {
    this.segments = segments;
    this.cached = undefined;
  }

  setText(text: string): void {
    this.set([{ kind: "line", text }]);
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached && this.cached.width === width) return this.cached.lines;
    const wrapWidth = previewWrapWidth(width);
    const lines: string[] = [];
    for (const seg of this.segments) {
      if (seg.kind === "line") {
        lines.push(seg.text);
        continue;
      }
      for (const l of wrapTextWithAnsi(seg.text, wrapWidth - PREVIEW_INDENT.length)) {
        lines.push(seg.style(PREVIEW_INDENT + l));
      }
    }
    this.cached = { width, lines };
    return lines;
  }
}

// ── Renderer callbacks (theme + TUI assembly only) ────────────────────────────

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
    const comp =
      context.lastComponent instanceof PreviewText ? context.lastComponent : new PreviewText();
    const contentText = result.content.find((item) => item.type === "text")?.text;
    if (isPartial) {
      comp.setText(theme.fg("muted", contentText ?? ""));
      return comp;
    }
    const details = result.details;
    if (details?.error) {
      comp.setText(theme.fg("error", details.error || contentText || "Search failed"));
      return comp;
    }
    if (!details) {
      // Sessions resumed across the renderer's introduction replay results
      // with no details payload — fall back to the text the tool returned.
      comp.setText(theme.fg("muted", contentText ?? "No web search results"));
      return comp;
    }
    const query = (context.args as WebSearchCallArgs | undefined)?.query ?? "";
    const muted = (s: string) => theme.fg("muted", s);
    const dim = (s: string) => theme.fg("dim", s);
    const segments: PreviewSegment[] = [];

    if (details.provider === "papers") {
      const view = papersView(details, { expanded, query });
      if (view.count === 0) {
        comp.setText(muted(`No results for “${view.query}”`));
        return comp;
      }
      const header: string[] = [];
      if (view.provider) header.push(dim(`${view.provider} ·`));
      header.push(theme.fg("success", `${view.count} result${view.count === 1 ? "" : "s"}`));
      header.push(dim(` for “${view.query}”`));
      segments.push({ kind: "line", text: header.join(" ") });
      for (const row of view.rows) {
        segments.push({ kind: "line", text: `${muted(`${row.index}.`)} ${theme.fg("accent", row.title)}` });
        if (row.summary) segments.push({ kind: "line", text: `   ${muted(row.summary)}` });
        if (expanded) {
          // The link always resolves: OA URL, then doi.org, then the row's
          // own URL — same priority the model text uses.
          const meta = [
            hyperlink(shortUrl(row.linkTarget), row.linkTarget),
            ...(row.trend ? [row.trend] : []),
          ].join(" · ");
          segments.push({ kind: "line", text: `   ${dim(meta)}` });
          if (row.abstract) segments.push({ kind: "block", text: row.abstract, style: muted });
        }
      }
      appendTail(segments, view.hiddenCount, view.nextCursor);
      comp.set(segments);
      return comp;
    }

    if (details.category === "people") {
      const view = peopleView(details, { expanded, query });
      if (view.count === 0) {
        comp.setText(muted(`No results for “${view.query}”`));
        return comp;
      }
      const header: string[] = [];
      if (view.provider) header.push(dim(`${view.provider} ·`));
      header.push(theme.fg("success", `${view.count} result${view.count === 1 ? "" : "s"}`));
      header.push(dim(` for “${view.query}”`));
      segments.push({ kind: "line", text: header.join(" ") });
      for (const row of view.rows) {
        segments.push({ kind: "line", text: `${muted(`${row.index}.`)} ${theme.fg("accent", row.name)}` });
        if (row.profile) segments.push({ kind: "block", text: row.profile, style: muted });
        const meta = [
          hyperlink(shortUrl(row.url), row.url),
          ...(row.publishedDate ? [row.publishedDate] : []),
        ].join(" · ");
        segments.push({ kind: "line", text: `   ${dim(meta)}` });
      }
      appendTail(segments, view.hiddenCount, view.nextCursor);
      comp.set(segments);
      return comp;
    }

    const view = searchView(details, { expanded, query });
    // An answer with zero citations is a success — the model returned prose
    // with no url_citation rows — so "No results" would misreport it.
    if (view.count === 0 && !view.answer) {
      comp.setText(muted(`No results for “${view.query}”`));
      return comp;
    }
    const header: string[] = [];
    if (view.provider) header.push(dim(`${view.provider} ·`));
    // The count drops when there is nothing to count and prose to show —
    // "0 results" above a rendered answer reads as failure.
    if (view.count > 0 || !view.answer) {
      header.push(theme.fg("success", `${view.count} result${view.count === 1 ? "" : "s"}`));
      header.push(dim(` for “${view.query}”`));
    } else {
      header.push(dim(`for “${view.query}”`));
    }
    segments.push({ kind: "line", text: header.join(" ") });
    if (view.answer) segments.push({ kind: "block", text: view.answer, style: muted });
    for (const row of view.rows) {
      // Links are real OSC 8 hyperlinks: short label, full clickable target.
      const label = row.titleIsUrl
        ? theme.fg("accent", hyperlink(row.title, row.url))
        : theme.fg("accent", row.title);
      let line = `${muted(`${row.index}.`)} ${label}`;
      if (row.publishedDate) line += dim(` — ${row.publishedDate}`);
      if (!row.titleIsUrl) line += dim(` — ${hyperlink(shortUrl(row.url), row.url)}`);
      segments.push({ kind: "line", text: line });
      if (row.snippet) segments.push({ kind: "block", text: row.snippet, style: muted });
    }
    appendTail(segments, view.hiddenCount, view.nextCursor);
    comp.set(segments);
    return comp;
  },
};

/** The collapsed tail every search-shaped view shares: the hidden remainder
 *  hint and the papers pagination pointer. */
function appendTail(segments: PreviewSegment[], hiddenCount: number, nextCursor?: string): void {
  if (hiddenCount > 0) {
    segments.push({ kind: "line", text: `…${hiddenCount} more` });
  }
  if (nextCursor) {
    segments.push({ kind: "line", text: `Next cursor: pass filters.cursor for the next page.` });
  }
}

interface WebFetchCallArgs {
  urls?: string | string[];
  mode?: string;
  topic?: string;
  prompt?: string;
  maxChars?: number;
}

export const webFetchRenderers: Pick<
  ToolDefinition<any, FetchDetails>,
  "renderCall" | "renderResult"
> = {
  renderCall(rawArgs, theme, context) {
    const args = (rawArgs ?? {}) as WebFetchCallArgs;
    const text =
      context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const urls = Array.isArray(args.urls) ? args.urls : args.urls ? [args.urls] : [];
    const parts = [theme.fg("toolTitle", theme.bold("fetch "))];
    parts.push(theme.fg("accent", urls.slice(0, 2).map((u) => `“${shortUrl(u)}”`).join(" ")));
    if (urls.length > 2) parts.push(theme.fg("dim", ` +${urls.length - 2}`));
    if (args.mode && args.mode !== "markdown") parts.push(theme.fg("dim", ` ${args.mode}`));
    if (args.topic) parts.push(theme.fg("dim", ` topic: ${args.topic}`));
    if (args.prompt) parts.push(theme.fg("dim", ` prompt`));
    if (args.maxChars) parts.push(theme.fg("dim", ` max=${args.maxChars}`));
    text.setText(parts.join(""));
    return text;
  },

  renderResult(
    result: AgentToolResult<FetchDetails>,
    { expanded, isPartial }: ToolRenderResultOptions,
    theme: Theme,
    context,
  ) {
    const comp =
      context.lastComponent instanceof PreviewText ? context.lastComponent : new PreviewText();
    const contentText = result.content.find((item) => item.type === "text")?.text;
    if (isPartial) {
      comp.setText(theme.fg("muted", contentText ?? ""));
      return comp;
    }
    const details = result.details;
    if (details?.error) {
      comp.setText(theme.fg("error", details.error || contentText || "Fetch failed"));
      return comp;
    }
    if (!details) {
      // Sessions resumed across the renderer's introduction replay results
      // with no details payload — fall back to the text the tool returned.
      comp.setText(theme.fg("muted", contentText ?? "No fetch result"));
      return comp;
    }
    const view = fetchView(details, { expanded });
    if (view.count === 0) {
      comp.setText(theme.fg("muted", "No content fetched"));
      return comp;
    }
    const header: string[] = [theme.fg("success", `${view.count} page${view.count === 1 ? "" : "s"}`)];
    if (view.summarized && view.model) header.push(theme.fg("dim", ` · summarized by ${view.model}`));
    const segments: PreviewSegment[] = [{ kind: "line", text: header.join(" ") }];
    if (view.summary) segments.push({ kind: "block", text: view.summary, style: (s) => theme.fg("muted", s) });
    segments.push(...fetchRowSegments(view, theme));
    comp.set(segments);
    return comp;
  },
};

/** The per-page segments of a fetch-shaped view: one-liner rows as final
 *  lines, raw content previews as blocks the component wraps at paint time.
 *  Shared by the fetch and crawl renderers — a crawled page is the same Page
 *  object a fetch returns. */
function fetchRowSegments(view: FetchView, theme: Theme): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  for (const row of view.rows) {
    if (row.error) {
      // Failed pages stay prominent: URL, then the actionable hint below.
      segments.push({ kind: "line", text: `${theme.fg("muted", `${row.index}.`)} ${theme.fg("accent", shortUrl(row.url))}` });
      segments.push({ kind: "line", text: `   ${theme.fg("error", row.error)}` });
      continue;
    }
    let line = `${theme.fg("muted", `${row.index}.`)} ${theme.fg("accent", row.title)}`;
    line += theme.fg("dim", ` — ${hyperlink(shortUrl(row.url), row.url)} · ${formatChars(row.chars)}`);
    segments.push({ kind: "line", text: line });
    if (row.preview) segments.push({ kind: "block", text: row.preview, style: (s) => theme.fg("muted", s) });
  }
  if (view.hiddenCount > 0) {
    segments.push({ kind: "line", text: theme.fg("dim", `…${view.hiddenCount} more`) });
  }
  return segments;
}

// ── Crawl renderer (theme + TUI assembly only) ──────────────────────────────

/** The details payload web_crawl's execute() returns — the fetch shape plus
 *  the sweep's own facts: which discovery path supplied the inventory and
 *  whether it stopped on budget. */
export interface CrawlDetails extends FetchDetails {
  source?: "sitemap" | "links" | "js";
  capped?: boolean;
  found?: number;
}

interface WebCrawlCallArgs {
  seed?: string;
  maxPages?: number;
  depth?: number;
}

export const webCrawlRenderers: Pick<
  ToolDefinition<any, CrawlDetails>,
  "renderCall" | "renderResult"
> = {
  renderCall(rawArgs, theme, context) {
    const args = (rawArgs ?? {}) as WebCrawlCallArgs;
    const text =
      context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const parts = [theme.fg("toolTitle", theme.bold("crawl "))];
    if (args.seed) parts.push(theme.fg("accent", `“${shortUrl(args.seed)}”`));
    if (args.maxPages !== undefined) parts.push(theme.fg("dim", ` max=${args.maxPages}`));
    if (args.depth !== undefined && args.depth !== 1) parts.push(theme.fg("dim", ` depth=${args.depth}`));
    text.setText(parts.join(""));
    return text;
  },

  renderResult(
    result: AgentToolResult<CrawlDetails>,
    { expanded, isPartial }: ToolRenderResultOptions,
    theme: Theme,
    context,
  ) {
    const comp =
      context.lastComponent instanceof PreviewText ? context.lastComponent : new PreviewText();
    const contentText = result.content.find((item) => item.type === "text")?.text;
    if (isPartial) {
      comp.setText(theme.fg("muted", contentText ?? ""));
      return comp;
    }
    const details = result.details;
    if (details?.error) {
      comp.setText(theme.fg("error", details.error || contentText || "Crawl failed"));
      return comp;
    }
    if (!details) {
      // Sessions resumed across the renderer's introduction replay results
      // with no details payload — fall back to the text the tool returned.
      comp.setText(theme.fg("muted", contentText ?? "No crawl result"));
      return comp;
    }
    const view = fetchView(details, { expanded });
    if (view.count === 0) {
      comp.setText(theme.fg("muted", "No pages swept"));
      return comp;
    }
    const header: string[] = [theme.fg("success", `${view.count} page${view.count === 1 ? "" : "s"} swept`)];
    if (details.capped) {
      const more = Math.max(0, (details.found ?? view.count) - view.count);
      header.push(theme.fg("warning", `· capped, ~${more} more exist`));
    } else {
      header.push(theme.fg("dim", "· complete"));
    }
    if (details.source) header.push(theme.fg("dim", `· ${details.source}`));
    const segments: PreviewSegment[] = [{ kind: "line", text: header.join(" ") }];
    segments.push(...fetchRowSegments(view, theme));
    comp.set(segments);
    return comp;
  },
};
