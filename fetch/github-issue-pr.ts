// github-issue-pr.ts — deep module: rich, deterministic rendering of a GitHub
// issue or pull request. Ported from pi-web-access (github-issue-pr.ts) and
// reshaped for pi-reader's handler architecture. The seam:
//
//   parseIssuePrUrl(url)              -> {owner, repo, kind, number, anchor?} | null
//   fetchIssuePr(info, opts?)         -> HandlerResult (rendered document)
//   renderIssuePr(data)               -> string (pure; the test surface)
//   mapRestView(info, restJson)       -> view (pure; REST -> gh view shape)
//
// Transport: gh CLI first (`gh pr view --json <rich fields>` — auth covers
// private repos and lifts the 60 req/h anonymous limit); old gh versions that
// reject unknown JSON fields retry with a core field set + availability note.
// gh absent or failed -> api.github.com REST fallback via the shared
// SSRF-guarded httpGet, mapped to the same view shape so ONE renderer serves
// both paths. Degradation is explicit: `*Unavailable` flags and availability
// notes, never silent omissions, plus escalation commands (`gh pr view`,
// `gh pr diff`) so the agent can always reach the complete data.

import { execFile } from "node:child_process";
import type { HandlerResult } from "./handlers/handler.ts";
import { FetchError, httpGet } from "./handlers/handler.ts";
import type { CloneExec } from "./github-clone.ts";
import { loadConfig } from "../config.ts";

// ── Public interface ─────────────────────────────────────────────────────────

export interface IssuePrRef {
  owner: string;
  repo: string;
  kind: "pull" | "issue";
  number: number;
  anchor?: string;
}

export interface RestReply {
  ok: boolean;
  status: number;
  rateLimited: boolean;
  json: unknown;
}

export type RestFetch = (url: string, signal?: AbortSignal) => Promise<RestReply>;

export interface IssuePrOptions {
  signal?: AbortSignal;
  /** Test seam: replaces the real gh subprocess runner. */
  exec?: CloneExec;
  /** Test seam: replaces the REST fetcher (default: shared SSRF-guarded httpGet). */
  rest?: RestFetch;
}

export interface RenderData {
  owner: string;
  repo: string;
  kind: "pull" | "issue";
  number: number;
  anchor?: string;
  view: Record<string, unknown>;
  reviewThreads: Record<string, unknown>[];
  threadsBounded?: boolean;
  threadsUnavailable?: boolean;
  notes: string[];
}

const PR_SUBPATHS = new Set(["files", "commits", "checks", "conversation"]);

const PR_FIELDS = [
  "title", "number", "state", "isDraft", "author", "baseRefName", "headRefName", "headRepositoryOwner",
  "createdAt", "mergedAt", "closedAt", "labels", "milestone", "additions", "deletions", "changedFiles",
  "files", "commits", "reviews", "statusCheckRollup", "comments", "body", "closingIssuesReferences", "url",
];
const PR_CORE_FIELDS = [
  "title", "number", "state", "isDraft", "author", "baseRefName", "headRefName", "headRepositoryOwner",
  "createdAt", "mergedAt", "closedAt", "labels", "milestone", "additions", "deletions", "changedFiles",
  "files", "commits", "comments", "body", "url",
];
const ISSUE_FIELDS = [
  "title", "number", "state", "stateReason", "author", "createdAt", "closedAt", "labels", "assignees",
  "milestone", "comments", "body", "closedByPullRequestsReferences", "url",
];
const ISSUE_CORE_FIELDS = [
  "title", "number", "state", "stateReason", "author", "createdAt", "closedAt", "labels", "assignees",
  "milestone", "comments", "body", "url",
];

// Renderer caps (mirror pi-web-access).
const MAX_DOC_CHARS = 150_000;
const BODY_INLINE_CHARS = 4_000;
const COMMENT_INLINE_CHARS = 700;
const MAX_INLINE_COMMENTS = 15;
const MAX_INLINE_REVIEWS = 10;
const MAX_INLINE_CHECKS = 15;
const MAX_INLINE_FILES = 50;
const MAX_INLINE_COMMITS = 20;
const MAX_INLINE_THREADS = 30;
const GH_TIMEOUT_MS = 10_000;

/** Pure parse seam: null when the URL is not an issue/PR document we render. */
export function parseIssuePrUrl(url: URL): IssuePrRef | null {
  if (!/(^|\.)github\.com$/.test(url.hostname.toLowerCase())) return null;
  const segments: string[] = [];
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.length < 4) return null;
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/, "");
  if (!validOwner(owner) || !validRepo(repo)) return null;
  const route = (segments[2] ?? "").toLowerCase();
  if (route !== "pull" && route !== "issues") return null;
  if (!/^\d+$/.test(segments[3] ?? "")) return null;
  const subpath = segments[4]?.toLowerCase();
  if (route === "pull" && subpath && !PR_SUBPATHS.has(subpath)) return null;
  if (route === "issues" && subpath) return null;
  const number = Number.parseInt(segments[3]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const fragment = url.hash.slice(1);
  const anchorPattern = route === "pull" ? /^(?:issuecomment-\d+|discussion_r\d+)$/i : /^issuecomment-\d+$/i;
  const anchor = anchorPattern.test(fragment) ? fragment : undefined;
  return { owner, repo, kind: route === "pull" ? "pull" : "issue", number, ...(anchor ? { anchor } : {}) };
}

function validOwner(owner: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && !owner.includes("--");
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== "." && repo !== "..";
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function fetchIssuePr(info: IssuePrRef, opts: IssuePrOptions = {}): Promise<HandlerResult> {
  const ghEnabled = normalizeEnabled(loadConfig()?.githubIssuePr);

  if (ghEnabled) {
    const runner = opts.exec ?? defaultGhExec;
    const hasGh = (await runner("gh", ["--version"], { timeoutMs: 5000 })).code === 0;
    if (hasGh) {
      const viewed = await ghView(info, runner, opts.signal);
      if (viewed) {
        const threads = await ghReviewThreads(info, runner, opts.signal);
        if (threads.anchorUnavailable) viewed.view.anchorUnavailable = true;
        const notes = [...viewed.notes];
        return {
          kind: info.kind,
          title: `${info.owner}/${info.repo} ${info.kind} #${info.number}: ${stringValue(viewed.view.title) || `#${info.number}`}`,
          content: renderIssuePr({
            owner: info.owner, repo: info.repo, kind: info.kind, number: info.number, anchor: info.anchor,
            view: viewed.view, reviewThreads: threads.comments,
            threadsBounded: threads.bounded, threadsUnavailable: threads.unavailable, notes,
          }),
        };
      }
    }
  }

  return restFallback(info, opts);
}

function normalizeEnabled(section: unknown): boolean {
  const enabled = (section as { enabled?: unknown } | undefined)?.enabled;
  return typeof enabled === "boolean" ? enabled : true;
}

function unknownJsonField(stderr: string): boolean {
  return /unknown (?:json )?field|UnknownField|Unknown JSON field/i.test(stderr);
}

async function ghView(
  info: IssuePrRef,
  runner: CloneExec,
  signal?: AbortSignal,
): Promise<{ view: Record<string, unknown>; notes: string[] } | null> {
  const repoArg = `${info.owner}/${info.repo}`;
  const command = info.kind === "pull" ? "pr" : "issue";
  const fields = info.kind === "pull" ? PR_FIELDS : ISSUE_FIELDS;
  const coreFields = info.kind === "pull" ? PR_CORE_FIELDS : ISSUE_CORE_FIELDS;
  let result = await runner("gh", [command, "view", String(info.number), "--repo", repoArg, "--json", fields.join(",")], { timeoutMs: GH_TIMEOUT_MS, signal });
  const notes: string[] = [];
  let linkedReferencesUnavailable = false;
  if (result.code !== 0 && unknownJsonField(result.stderr)) {
    result = await runner("gh", [command, "view", String(info.number), "--repo", repoArg, "--json", coreFields.join(",")], { timeoutMs: GH_TIMEOUT_MS, signal });
    notes.push("Some GitHub fields were unavailable from this gh version; retried with the core field set.");
    linkedReferencesUnavailable = true;
  }
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const view = parsed as Record<string, unknown>;
    if (linkedReferencesUnavailable) view.linkedReferencesUnavailable = true;
    return { view, notes };
  } catch {
    return null;
  }
}

async function ghReviewThreads(
  info: IssuePrRef,
  runner: CloneExec,
  signal?: AbortSignal,
): Promise<{ comments: Record<string, unknown>[]; bounded?: boolean; unavailable?: boolean; anchorUnavailable?: boolean }> {
  if (info.kind !== "pull") return { comments: [] };
  const comments: Record<string, unknown>[] = [];
  let bounded = false;
  let pageFailed = false;
  for (let page = 1; page <= 3; page++) {
    const result = await runner("gh", ["api", `repos/${info.owner}/${info.repo}/pulls/${info.number}/comments?per_page=100&page=${page}`], { timeoutMs: GH_TIMEOUT_MS, signal });
    if (result.code !== 0) {
      pageFailed = true;
      break;
    }
    let pageItems: unknown;
    try {
      pageItems = JSON.parse(result.stdout);
    } catch {
      pageFailed = true;
      break;
    }
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    comments.push(...objectArray(pageItems));
    if (pageItems.length < 100) break;
    if (page === 3) bounded = true;
  }
  // V1 trim: a discussion_r anchor outside the fetched pages is reported
  // unavailable rather than fetched individually.
  const discussionId = anchorId(info.anchor, "discussion_r");
  const anchorUnavailable = discussionId !== null && !hasCommentId(comments, discussionId);
  return {
    comments,
    bounded: bounded || (pageFailed && comments.length > 0),
    unavailable: pageFailed && comments.length === 0,
    ...(anchorUnavailable ? { anchorUnavailable: true } : {}),
  };
}

// ── REST fallback ────────────────────────────────────────────────────────────

const REST_HEADERS = { "Accept": "application/vnd.github+json", "User-Agent": "pi-reader" };

const defaultRest: RestFetch = async (url, signal) => {
  const res = await httpGet(url, signal, REST_HEADERS);
  const rateLimited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
  let json: unknown = null;
  if (res.ok) {
    try {
      json = await res.json();
    } catch {
      json = null;
    }
  }
  return { ok: res.ok, status: res.status, rateLimited, json };
};

async function restFallback(info: IssuePrRef, opts: IssuePrOptions): Promise<HandlerResult> {
  const rest = opts.rest ?? defaultRest;
  const base = `https://api.github.com/repos/${info.owner}/${info.repo}`;
  const mainPath = info.kind === "pull" ? `${base}/pulls/${info.number}` : `${base}/issues/${info.number}`;

  let main: RestReply;
  try {
    main = await rest(mainPath, opts.signal);
  } catch (err) {
    throw new FetchError(`GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (main.rateLimited) return rateLimitResult(info, main.status);
  if (!main.ok || !main.json || typeof main.json !== "object") {
    throw new FetchError(`GitHub API returned ${main.status} for ${info.owner}/${info.repo} ${info.kind} #${info.number}`);
  }

  const view = mapRestView(info, main.json);
  view.linkedReferencesUnavailable = true;
  const notes = [info.kind === "pull"
    ? "REST fallback used; checks, reviews, and commits unavailable in this path; authenticate gh for the complete view."
    : "REST fallback used; gh fields unavailable."];

  const conversationComments: Record<string, unknown>[] = [];
  const commentsReply = await rest(`${base}/issues/${info.number}/comments?per_page=50`, opts.signal).catch(() => null);
  if (commentsReply?.rateLimited) return rateLimitResult(info, commentsReply.status);
  if (commentsReply?.ok && Array.isArray(commentsReply.json)) conversationComments.push(...objectArray(commentsReply.json));
  const issueCommentId = anchorId(info.anchor, "issuecomment");
  if (issueCommentId !== null && !hasCommentId(conversationComments, issueCommentId)) {
    const anchored = await rest(`${base}/issues/comments/${issueCommentId}`, opts.signal).catch(() => null);
    if (anchored?.rateLimited) return rateLimitResult(info, anchored.status);
    const comment = anchored?.ok && anchored.json && typeof anchored.json === "object" ? anchored.json as Record<string, unknown> : null;
    if (comment && belongsToIssue(comment, issueCommentId, info)) conversationComments.push(comment);
    else view.anchorUnavailable = true;
  }
  view.comments = conversationComments;

  const reviewThreads: Record<string, unknown>[] = [];
  if (info.kind === "pull") {
    view.reviewsUnavailable = true;
    view.commitsUnavailable = true;
    const files = await rest(`${base}/pulls/${info.number}/files?per_page=50`, opts.signal).catch(() => null);
    if (files?.rateLimited) return rateLimitResult(info, files.status);
    if (files?.ok && Array.isArray(files.json)) view.files = files.json;
    const threads = await rest(`${base}/pulls/${info.number}/comments?per_page=50`, opts.signal).catch(() => null);
    if (threads?.rateLimited) return rateLimitResult(info, threads.status);
    if (threads?.ok && Array.isArray(threads.json)) reviewThreads.push(...objectArray(threads.json));
  }

  return {
    kind: info.kind,
    title: `${info.owner}/${info.repo} ${info.kind} #${info.number}: ${stringValue(view.title) || `#${info.number}`}`,
    content: renderIssuePr({
      owner: info.owner, repo: info.repo, kind: info.kind, number: info.number, anchor: info.anchor,
      view, reviewThreads, notes,
    }),
  };
}

function rateLimitResult(info: IssuePrRef, status: number): HandlerResult {
  return {
    kind: info.kind,
    title: `${info.owner}/${info.repo}#${info.number}`,
    content: [
      `GitHub API rate limit reached for ${info.owner}/${info.repo} ${info.kind} #${info.number} (HTTP ${status}).`,
      "",
      "Authenticate the gh CLI, then fetch this URL again:",
      "",
      "`gh auth login`",
    ].join("\n"),
  };
}

/** REST -> gh view shape, so one renderer serves both transports. Pure. */
export function mapRestView(info: IssuePrRef, value: unknown): Record<string, unknown> {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const user = record(source.user);
  const base = record(source.base);
  const head = record(source.head);
  const headRepo = record(head.repo);
  return {
    title: stringValue(source.title),
    number: numberValue(source.number) ?? info.number,
    state: stringValue(source.state),
    stateReason: stringValue(source.state_reason),
    isDraft: Boolean(source.draft),
    author: { login: user ? stringValue(user.login) : "" },
    baseRefName: base ? stringValue(base.ref) : "",
    headRefName: head ? stringValue(head.ref) : "",
    headRepositoryOwner: { login: headRepo.owner ? stringValue(record(headRepo.owner).login) : "" },
    createdAt: stringValue(source.created_at),
    mergedAt: stringValue(source.merged_at),
    closedAt: stringValue(source.closed_at),
    labels: source.labels,
    assignees: source.assignees,
    milestone: source.milestone,
    additions: source.additions,
    deletions: source.deletions,
    changedFiles: source.changed_files,
    body: stringValue(source.body),
    url: stringValue(source.html_url),
    commentsCount: source.comments,
    reviewCommentsCount: source.review_comments,
  };
}

// ── Default gh runner ────────────────────────────────────────────────────────

const defaultGhExec: CloneExec = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(command, args, {
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      signal: opts.signal,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? (err as NodeJS.ErrnoException).code : err ? 1 : 0;
      resolve({ stdout, stderr, code: typeof code === "number" ? code : 0 });
    });
  });

// ── Renderer ─────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function authorLogin(value: unknown): string {
  const login = record(value).login;
  return typeof login === "string" && login ? login : "unknown";
}

function listNames(value: unknown): string {
  const names = objectArray(value)
    .map((item) => stringValue(item.name) || stringValue(item.login) || stringValue(item.title))
    .filter(Boolean);
  return names.length > 0 ? names.join(", ") : "none";
}

function milestoneTitle(value: unknown): string {
  return stringValue(record(value).title) || "none";
}

function commentId(comment: Record<string, unknown>): string {
  return String(comment.id ?? comment.databaseId ?? "");
}

function anchorId(anchor: string | undefined, prefix: "issuecomment" | "discussion_r"): string | null {
  const match = anchor?.match(prefix === "issuecomment" ? /^issuecomment-(\d+)$/i : /^discussion_r(\d+)$/i);
  return match?.[1] ?? null;
}

function hasCommentId(comments: Record<string, unknown>[], id: string): boolean {
  return comments.some((comment) => commentId(comment) === id);
}

function belongsToIssue(comment: Record<string, unknown>, id: string, info: IssuePrRef): boolean {
  return commentId(comment) === id && associationMatches(comment.issue_url, info, "issues");
}

function associationMatches(value: unknown, info: IssuePrRef, route: "issues" | "pulls"): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.github.com") return false;
    return parsed.pathname.toLowerCase() === `/repos/${info.owner}/${info.repo}/${route}/${info.number}`.toLowerCase();
  } catch {
    return false;
  }
}

function truncateText(text: string, limit: number, label: string, appendix: string[]): string {
  if (text.length <= limit) return text;
  appendix.push(`## Full ${label}\n\n${text}`);
  return `${text.slice(0, limit)}\n\n[${label} truncated; see the escalation commands below for the full text]`;
}

function appendLimitedSection(lines: string[], title: string, items: string[], max: number, marker: string): void {
  lines.push(`## ${title}`);
  if (items.length === 0) {
    lines.push("none", "");
    return;
  }
  lines.push(...items.slice(0, max));
  if (items.length > max) lines.push(`[${max} of ${items.length} ${marker} shown]`);
  lines.push("");
}

function anchorMatches(anchor: string | undefined, comment: Record<string, unknown>): boolean {
  if (!anchor) return false;
  const id = commentId(comment);
  return anchor === `issuecomment-${id}` || anchor === `discussion_r${id}`;
}

function renderComments(comments: Record<string, unknown>[], anchor: string | undefined, appendix: string[]): string[] {
  const forced = anchor ? comments.find((comment) => anchorMatches(anchor, comment)) : undefined;
  const selected = comments.slice(0, MAX_INLINE_COMMENTS);
  if (forced && !selected.includes(forced)) selected.push(forced);
  return selected.map((comment, index) => {
    const body = stringValue(comment.body);
    const label = `comment ${commentId(comment) || index + 1}`;
    return `- ${authorLogin(comment.author ?? comment.user)} at ${stringValue(comment.createdAt) || stringValue(comment.created_at)}${forced === comment ? " [anchored]" : ""}:\n  ${truncateText(body, COMMENT_INLINE_CHARS, label, appendix).replace(/\n/g, "\n  ")}`;
  });
}

function commentCountText(view: Record<string, unknown>): string {
  const comments = objectArray(view.comments).length;
  const total = numberValue(view.commentsCount);
  if (total !== null && total > comments) return `at least ${total}`;
  return String(comments || total || 0);
}

function reviewThreadCountText(comments: Record<string, unknown>[], total: unknown, bounded?: boolean, unavailable?: boolean): string {
  if (unavailable) return "unavailable";
  const knownTotal = numberValue(total);
  if (bounded) return `at least ${comments.length}`;
  if (knownTotal !== null && knownTotal > comments.length) return `at least ${knownTotal}`;
  return String(comments.length || knownTotal || 0);
}

function renderChecks(value: unknown): string[] {
  const checks = objectArray(value);
  if (checks.length === 0) return ["No check rollup data available."];
  const rows = checks.map((check) => {
    const name = stringValue(check.name) || stringValue(check.context) || stringValue(check.workflowName) || "check";
    const state = stringValue(check.conclusion) || stringValue(check.status) || stringValue(check.state) || "unknown";
    return `- ${name}: ${state}`;
  });
  const failing = rows.filter((row) => !/(success|neutral|skipped|completed)$/i.test(row));
  return [
    `Rollup: ${failing.length === 0 ? "no failing checks in shown data" : `${failing.length} non-passing checks in shown data`}`,
    ...rows.slice(0, MAX_INLINE_CHECKS),
    ...(rows.length > MAX_INLINE_CHECKS ? [`[${MAX_INLINE_CHECKS} of ${rows.length} checks shown]`] : []),
  ];
}

function renderReviewVerdicts(value: unknown, appendix: string[]): string[] {
  const latest = new Map<string, Record<string, unknown>>();
  for (const review of objectArray(value)) latest.set(authorLogin(review.author ?? review.user), review);
  return [...latest.entries()].map(([author, review]) => {
    const state = stringValue(review.state) || "COMMENTED";
    const body = truncateText(stringValue(review.body), 300, `review by ${author}`, appendix);
    return `- ${author}: ${state}${body ? ` — ${body.replace(/\n/g, " ")}` : ""}`;
  });
}

function renderVerdictsOrUnavailable(view: Record<string, unknown>, appendix: string[]): string[] {
  const rendered = renderReviewVerdicts(view.reviews, appendix);
  if (rendered.length > 0) return rendered;
  return view.reviewsUnavailable === true ? ["Unavailable in this GitHub fetch path; use gh for review verdicts."] : [];
}

function renderCommits(value: unknown): string[] {
  return objectArray(value).map((commit) => {
    const oid = stringValue(commit.oid) || stringValue(commit.sha);
    const message = stringValue(commit.messageHeadline) || stringValue(record(commit.commit).message).split("\n")[0] || "";
    return `- ${oid.slice(0, 7)} ${message}`.trim();
  });
}

function renderCommitsOrUnavailable(view: Record<string, unknown>): string[] {
  const rendered = renderCommits(view.commits);
  if (rendered.length > 0) return rendered;
  return view.commitsUnavailable === true ? ["Unavailable in this GitHub fetch path; use gh for commits."] : [];
}

function renderLinked(value: unknown, kind: "closing" | "closedBy"): string[] {
  return objectArray(value).map((item) =>
    `- #${numberValue(item.number) ?? "?"} ${stringValue(item.title)}${kind === "closedBy" ? ` (${stringValue(item.url)})` : ""}`);
}

function renderLinkedOrUnavailable(view: Record<string, unknown>, field: "closingIssuesReferences" | "closedByPullRequestsReferences", kind: "closing" | "closedBy"): string[] {
  const linked = renderLinked(view[field], kind);
  if (linked.length > 0) return linked;
  return view.linkedReferencesUnavailable === true ? ["Unavailable in this GitHub fetch path; use gh for linked references."] : [];
}

function renderReviewThreads(
  comments: Record<string, unknown>[],
  anchor: string | undefined,
  appendix: string[],
  total: unknown,
  bounded?: boolean,
  unavailable?: boolean,
): string[] {
  if (unavailable) return ["Unavailable in this GitHub fetch path; use gh for review thread comments."];
  const forced = anchor ? comments.find((comment) => anchorMatches(anchor, comment)) : undefined;
  const selected = comments.slice(0, MAX_INLINE_THREADS);
  if (forced && !selected.includes(forced)) selected.push(forced);
  const lines = selected.map((comment, index) => {
    const path = stringValue(comment.path) || "unknown path";
    const line = numberValue(comment.line) ?? numberValue(comment.original_line) ?? numberValue(comment.position) ?? "?";
    const body = truncateText(stringValue(comment.body), COMMENT_INLINE_CHARS, `review thread comment ${commentId(comment) || index + 1}`, appendix);
    return `- ${path}:${line} — ${authorLogin(comment.user ?? comment.author)}${forced === comment ? " [anchored]" : ""}:\n  ${body.replace(/\n/g, "\n  ")}`;
  });
  const knownTotal = numberValue(total);
  if (bounded) lines.push(`[${selected.length} review thread comments shown from at least ${comments.length}]`);
  else if (knownTotal !== null && knownTotal > comments.length) lines.push(`[${selected.length} review thread comments shown from at least ${knownTotal}]`);
  else if (comments.length > selected.length) lines.push(`[${selected.length} of ${comments.length} review thread comments shown]`);
  return lines;
}

/** Pure render seam: fixture view JSON in, deterministic document out. */
export function renderIssuePr(data: RenderData): string {
  const { view } = data;
  const appendix: string[] = [];
  const title = stringValue(view.title) || `${data.owner}/${data.repo}#${data.number}`;
  const number = numberValue(view.number) ?? data.number;
  const stateParts = [stringValue(view.state) || "unknown"];
  if (view.isDraft === true) stateParts.push("draft");
  const lines: string[] = [`#${number} ${title}`, ""];
  lines.push(`- type: ${data.kind}`);
  lines.push(`- state: ${stateParts.join(" ")}${stringValue(view.stateReason) ? ` (${stringValue(view.stateReason)})` : ""}`);
  lines.push(`- author: ${authorLogin(view.author)}`);
  if (data.kind === "pull") {
    const headOwner = authorLogin(view.headRepositoryOwner);
    const headRef = stringValue(view.headRefName);
    const head = headOwner !== "unknown" && headOwner !== data.owner ? `${headOwner}:${headRef}` : headRef;
    lines.push(`- branch: ${stringValue(view.baseRefName)} ← ${head}`);
    const commitSummary = view.commitsUnavailable === true ? "commits unavailable" : `${objectArray(view.commits).length} commits`;
    lines.push(`- changes: +${numberValue(view.additions) ?? 0} −${numberValue(view.deletions) ?? 0}, ${numberValue(view.changedFiles) ?? objectArray(view.files).length} files, ${commitSummary}`);
  } else {
    lines.push(`- assignees: ${listNames(view.assignees)}`);
  }
  lines.push(`- created: ${stringValue(view.createdAt) || "unknown"}`);
  if (stringValue(view.mergedAt)) lines.push(`- merged: ${stringValue(view.mergedAt)}`);
  if (stringValue(view.closedAt)) lines.push(`- closed: ${stringValue(view.closedAt)}`);
  lines.push(`- labels: ${listNames(view.labels)}`);
  lines.push(`- milestone: ${milestoneTitle(view.milestone)}`);
  lines.push(`- comments: ${commentCountText(view)}; review threads: ${reviewThreadCountText(data.reviewThreads, view.reviewCommentsCount, data.threadsBounded, data.threadsUnavailable)}`);
  if (data.anchor) lines.push(`- requested anchor: #${data.anchor}`);
  lines.push("");

  lines.push("## Body");
  lines.push(truncateText(stringValue(view.body) || "(empty)", BODY_INLINE_CHARS, "body", appendix), "");

  if (data.kind === "pull") {
    lines.push("## Checks");
    lines.push(...renderChecks(view.statusCheckRollup), "");
    appendLimitedSection(lines, "Review verdicts", renderVerdictsOrUnavailable(view, appendix), MAX_INLINE_REVIEWS, "review verdicts");
    appendLimitedSection(lines, "Linked references", renderLinkedOrUnavailable(view, "closingIssuesReferences", "closing"), 20, "linked references");
    lines.push("## Files");
    const files = objectArray(view.files).map((file) => {
      const path = stringValue(file.path) || stringValue(file.filename) || "file";
      return `- ${path} (+${numberValue(file.additions) ?? 0}/−${numberValue(file.deletions) ?? 0})`;
    });
    if (files.length === 0) {
      const total = numberValue(view.changedFiles);
      lines.push(total !== null && total > 0 ? `[0 files shown from at least ${total}]` : "none", "");
    } else {
      lines.push(...files.slice(0, MAX_INLINE_FILES));
      if (files.length > MAX_INLINE_FILES) lines.push(`[${MAX_INLINE_FILES} of ${files.length} files shown]`);
      lines.push("");
    }
    appendLimitedSection(lines, "Commits", renderCommitsOrUnavailable(view), MAX_INLINE_COMMITS, "commits");
  } else {
    appendLimitedSection(lines, "Closed by pull requests", renderLinkedOrUnavailable(view, "closedByPullRequestsReferences", "closedBy"), 20, "pull requests");
  }

  lines.push("## Conversation comments");
  const commentLines = renderComments(objectArray(view.comments), data.anchor, appendix);
  const comments = objectArray(view.comments);
  const knownTotal = numberValue(view.commentsCount);
  if (knownTotal !== null && knownTotal > comments.length) commentLines.push(`[at least ${knownTotal} comments; use the escalation commands below for more]`);
  else if (comments.length > commentLines.length) commentLines.push(`[${commentLines.length} of ${comments.length} comments shown]`);
  if (view.anchorUnavailable === true && data.anchor?.startsWith("issuecomment-")) {
    commentLines.push("[anchored comment unavailable for this issue or pull request]");
  }
  lines.push(...(commentLines.length > 0 ? commentLines : ["none"]), "");

  if (data.kind === "pull") {
    lines.push("## Review thread comments");
    const threadLines = renderReviewThreads(data.reviewThreads, data.anchor, appendix, view.reviewCommentsCount, data.threadsBounded, data.threadsUnavailable);
    if (view.anchorUnavailable === true && data.anchor?.startsWith("discussion_r")) {
      threadLines.push("[anchored review thread comment unavailable for this pull request]");
    }
    lines.push(...(threadLines.length > 0 ? threadLines : ["none"]), "");
  }

  if (data.notes.length > 0) lines.push("## Availability notes", ...data.notes.map((note) => `- ${note}`), "");
  if (appendix.length > 0) lines.push("## Appendix", ...appendix, "");

  const viewCommand = data.kind === "pull"
    ? `gh pr view ${data.number} --repo ${data.owner}/${data.repo}`
    : `gh issue view ${data.number} --repo ${data.owner}/${data.repo} -c`;
  lines.push("## Escalation commands");
  lines.push(`- Full view: \`${viewCommand}\``);
  if (data.kind === "pull") lines.push(`- Complete diff: \`gh pr diff ${data.number} --repo ${data.owner}/${data.repo}\``);

  const content = lines.join("\n");
  return content.length > MAX_DOC_CHARS
    ? `${content.slice(0, MAX_DOC_CHARS)}\n\n[GitHub document truncated at ${MAX_DOC_CHARS} chars; use the escalation commands for complete data]`
    : content;
}
