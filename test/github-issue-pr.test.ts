// Tests for fetch/github-issue-pr.ts — parse, render, REST-view mapping, and
// gh transport seams. Network never touched: gh goes through an injected fake
// exec, the REST fallback through an injected rest fetcher, and rendering runs
// on in-line fixture JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIssuePr, mapRestView, parseIssuePrUrl, renderIssuePr, type GhExec } from "../fetch/github-issue-pr.ts";
import type { RestReply } from "../fetch/github-issue-pr.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const prView = {
  title: "Fix the bug",
  number: 7,
  state: "OPEN",
  isDraft: false,
  author: { login: "alice" },
  baseRefName: "main",
  headRefName: "fix",
  headRepositoryOwner: { login: "udit-001" },
  createdAt: "2026-09-01T00:00:00Z",
  labels: [{ name: "bug" }],
  milestone: { title: "v2" },
  additions: 10,
  deletions: 2,
  changedFiles: 2,
  files: [
    { path: "src/a.ts", additions: 8, deletions: 1 },
    { path: "src/b.ts", additions: 2, deletions: 1 },
  ],
  commits: [{ oid: "abcdef1234567890", messageHeadline: "fix: the bug" }],
  reviews: [
    { author: { login: "bob" }, state: "APPROVED", body: "lgtm" },
    { author: { login: "bob" }, state: "COMMENTED", body: "one nit" },
  ],
  statusCheckRollup: [
    { name: "ci", conclusion: "FAILURE" },
    { name: "lint", conclusion: "SUCCESS" },
  ],
  comments: [
    { id: 1, author: { login: "carol" }, createdAt: "2026-09-02T00:00:00Z", body: "first" },
    { id: 2, author: { login: "dave" }, createdAt: "2026-09-03T00:00:00Z", body: "second" },
  ],
  body: "Fixes the bug described in #5.",
  url: "https://github.com/o/r/pull/7",
  closingIssuesReferences: [{ number: 5, title: "The bug" }],
};

function fakeExec(route: (command: string, args: string[]) => { stdout?: string; stderr?: string; code?: number } | undefined): {
  exec: GhExec;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: GhExec = async (command, args) => {
    calls.push({ command, args });
    const r = route(command, args);
    return { stdout: r?.stdout ?? "", stderr: r?.stderr ?? "", code: r?.code ?? 0 };
  };
  return { exec, calls };
}

type RestRoute = (url: string) => { status?: number; json?: unknown } | undefined;

function fakeRest(route: RestRoute): { rest: (url: string) => Promise<RestReply>; calls: string[] } {
  const calls: string[] = [];
  const rest = async (url: string) => {
    calls.push(url);
    const r = route(url);
    const status = r?.status ?? 200;
    return {
      ok: status < 400,
      status,
      rateLimited: status === 403,
      json: r?.json ?? null,
    };
  };
  return { rest, calls };
}

const isPullComments = (url: string) => /\/pulls\/7\/comments/.test(url);
const isIssueComments = (url: string) => /\/issues\/7\/comments/.test(url);

// ── Parse seam ───────────────────────────────────────────────────────────────

test("issue-pr: parse reads kind, number, and anchors", () => {
  const pull = parseIssuePrUrl(new URL("https://github.com/o/r/pull/7"));
  assert.deepEqual(pull, { owner: "o", repo: "r", kind: "pull", number: 7 });

  const anchored = parseIssuePrUrl(new URL("https://github.com/o/r/issues/12#issuecomment-99"));
  assert.deepEqual(anchored, { owner: "o", repo: "r", kind: "issue", number: 12, anchor: "issuecomment-99" });

  const threadAnchor = parseIssuePrUrl(new URL("https://github.com/o/r/pull/7#discussion_r42"));
  assert.equal(threadAnchor?.anchor, "discussion_r42");
});

test("issue-pr: parse enforces subpath and shape rules", () => {
  assert.ok(parseIssuePrUrl(new URL("https://github.com/o/r/pull/7/files")), "known PR subpath accepted");
  assert.equal(parseIssuePrUrl(new URL("https://github.com/o/r/pull/7/bogus")), null, "unknown PR subpath rejected");
  assert.equal(parseIssuePrUrl(new URL("https://github.com/o/r/issues/7/comments")), null, "issues subpaths rejected");
  assert.equal(parseIssuePrUrl(new URL("https://github.com/o/r/pull/abc")), null);
  assert.equal(parseIssuePrUrl(new URL("https://github.com/o/r/pull")), null);
  assert.equal(parseIssuePrUrl(new URL("https://github.com/o--o/r/pull/7")), null);
  assert.equal(parseIssuePrUrl(new URL("https://github.com/o/r/releases/1")), null);
});

// ── REST view mapping ────────────────────────────────────────────────────────

test("issue-pr: mapRestView normalizes a REST payload into the gh view shape", () => {
  const view = mapRestView(
    { owner: "o", repo: "r", kind: "pull", number: 7 },
    {
      title: "T", state: "open", draft: true, user: { login: "u" },
      base: { ref: "main" }, head: { ref: "f", repo: { owner: { login: "fork" } } },
      created_at: "2026-01-01T00:00:00Z", labels: [], milestone: null,
      additions: 3, deletions: 1, changed_files: 2, body: "b",
      html_url: "https://github.com/o/r/pull/7", comments: 4, review_comments: 9,
    },
  );
  assert.equal(view.title, "T");
  assert.deepEqual(view.author, { login: "u" });
  assert.equal(view.isDraft, true);
  assert.equal(view.headRepositoryOwner && (view.headRepositoryOwner as Record<string, unknown>).login, "fork");
  assert.equal(view.commentsCount, 4);
  assert.equal(view.reviewCommentsCount, 9);
});

// ── Render seam ──────────────────────────────────────────────────────────────

function renderPr(view: Record<string, unknown>, overrides?: Partial<Parameters<typeof renderIssuePr>[0]>): string {
  return renderIssuePr({
    owner: "o", repo: "r", kind: "pull", number: 7,
    view, reviewThreads: [], notes: [], ...overrides,
  });
}

test("issue-pr: renders the PR header facts", () => {
  const out = renderPr(prView as unknown as Record<string, unknown>);
  assert.match(out, /^#7 Fix the bug\n/);
  assert.match(out, /- type: pull/);
  assert.match(out, /- state: OPEN/);
  assert.match(out, /- author: alice/);
  assert.match(out, /- branch: main ← udit-001:fix/);
  assert.match(out, /- changes: \+10 −2, 2 files, 1 commits/);
  assert.match(out, /- labels: bug/);
  assert.match(out, /- milestone: v2/);
  assert.match(out, /- comments: 2; review threads: 0/);
});

test("issue-pr: renders checks with a failing-first rollup", () => {
  const out = renderPr(prView as unknown as Record<string, unknown>);
  assert.match(out, /Rollup: 1 non-passing checks in shown data/);
  assert.match(out, /- ci: FAILURE/);
  assert.match(out, /- lint: SUCCESS/);
});

test("issue-pr: dedupes review verdicts to the latest per author", () => {
  const out = renderPr(prView as unknown as Record<string, unknown>);
  assert.match(out, /- bob: COMMENTED — one nit/);
  assert.ok(!out.includes("APPROVED"), "superseded verdict dropped");
});

test("issue-pr: lists files with deltas and commits", () => {
  const out = renderPr(prView as unknown as Record<string, unknown>);
  assert.match(out, /- src\/a\.ts \(\+8\/−1\)/);
  assert.match(out, /- abcdef1 fix: the bug/);
  assert.match(out, /- #5 The bug/, "closing references rendered");
});

test("issue-pr: truncates long bodies into an appendix", () => {
  const long = "x".repeat(5000);
  const view = { ...prView, body: long, comments: [{ id: 1, author: { login: "c" }, body: "y".repeat(2000) }] };
  const out = renderPr(view as unknown as Record<string, unknown>);
  assert.match(out, /\[body truncated/);
  assert.match(out, /## Appendix/);
  assert.match(out, /## Full body/);
});

test("issue-pr: caps conversation comments and states the count", () => {
  const comments = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, author: { login: `u${i}` }, body: `c${i}`,
  }));
  const out = renderPr({ ...prView, comments } as unknown as Record<string, unknown>);
  assert.match(out, /\[15 of 20 comments shown/);
  assert.ok(out.includes("c14"), "15th comment present");
  assert.ok(!out.includes("c15"), "16th comment dropped");
});

test("issue-pr: force-includes the anchored comment and marks it", () => {
  const comments = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, author: { login: `u${i}` }, body: `c${i}`,
  }));
  const out = renderIssuePr({
    owner: "o", repo: "r", kind: "pull", number: 7, anchor: "issuecomment-20",
    view: { ...prView, comments } as unknown as Record<string, unknown>,
    reviewThreads: [], notes: [],
  });
  assert.match(out, /u19.*\[anchored\]/s);
  assert.ok(out.includes("c19"), "anchored comment included despite cap");
});

test("issue-pr: renders review threads as path:line", () => {
  const out = renderPr(prView as unknown as Record<string, unknown>, {
    reviewThreads: [{ id: 11, path: "src/a.ts", line: 3, user: { login: "bob" }, body: "rename this" }],
  });
  assert.match(out, /## Review thread comments/);
  assert.match(out, /- src\/a\.ts:3 — bob/);
});

test("issue-pr: issues render closed-by PRs and the issue escalation command", () => {
  const view = {
    title: "The bug", number: 5, state: "CLOSED", stateReason: "completed",
    author: { login: "alice" }, createdAt: "2026-08-01T00:00:00Z",
    labels: [], assignees: [{ login: "bob" }], milestone: null,
    comments: [], body: "It broke.",
    closedByPullRequestsReferences: [{ number: 7, title: "Fix the bug", url: "https://github.com/o/r/pull/7" }],
  };
  const out = renderIssuePr({ owner: "o", repo: "r", kind: "issue", number: 5, view, reviewThreads: [], notes: [] });
  assert.match(out, /- state: CLOSED \(completed\)/);
  assert.match(out, /- assignees: bob/);
  assert.match(out, /- #7 Fix the bug/);
  assert.match(out, /gh issue view 5 --repo o\/r -c/);
  assert.ok(!out.includes("## Checks"), "issues carry no checks section");
});

test("issue-pr: availability notes and unavailability flags render explicitly", () => {
  const out = renderPr({
    ...prView, reviews: [], commits: [],
    reviewsUnavailable: true, commitsUnavailable: true,
  } as unknown as Record<string, unknown>, {
    threadsUnavailable: true, notes: ["REST fallback used; gh fields unavailable."],
  });
  assert.match(out, /Unavailable in this GitHub fetch path; use gh for review verdicts/);
  assert.match(out, /Unavailable in this GitHub fetch path; use gh for commits/);
  assert.match(out, /use gh for review thread comments/);
  assert.match(out, /## Availability notes/);
  assert.match(out, /REST fallback used/);
});

// ── Transport (gh path + REST fallback) ──────────────────────────────────────

test("issue-pr: fetch uses gh pr view with the rich field set", async () => {
  const { exec, calls } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && args[0] === "api") return { stdout: "[]" };
    return { stdout: JSON.stringify(prView) };
  });
  const result = await fetchIssuePr({ owner: "o", repo: "r", kind: "pull", number: 7 }, { exec });
  assert.match(result.content, /^#7 Fix the bug/);
  const viewCall = calls.find((c) => c.command === "gh" && c.args[0] === "pr")!;
  assert.ok(viewCall.args.includes("--json"));
  assert.ok(viewCall.args.some((a) => a.includes("statusCheckRollup")), "rich field set requested");
});

test("issue-pr: unknown-field failure retries with the core field set and notes it", async () => {
  let viewCalls = 0;
  const { exec } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    if (command === "gh" && args[0] === "api") return { stdout: "[]" };
    if (command === "gh" && args[0] === "pr") {
      viewCalls++;
      if (viewCalls === 1) return { code: 1, stderr: `unknown json field: statusCheckRollup` };
      return { stdout: JSON.stringify(prView) };
    }
    return undefined;
  });
  const result = await fetchIssuePr({ owner: "o", repo: "r", kind: "pull", number: 7 }, { exec });
  assert.equal(viewCalls, 2);
  assert.match(result.content, /Some GitHub fields were unavailable from this gh version/);
});

test("issue-pr: gh absent falls back to REST with an availability note", async () => {
  const { exec, calls } = fakeExec(() => ({ code: 1 }));
  const { rest, calls: restCalls } = fakeRest((url) => {
    if (/\/pulls\/7$/.test(url)) return { json: restPull };
    if (isIssueComments(url)) return { json: [] };
    if (isPullComments(url)) return { json: [] };
    if (/\/pulls\/7\/files/.test(url)) return { json: [{ path: "a.ts", additions: 1, deletions: 0 }] };
    return { json: [] };
  });
  const result = await fetchIssuePr({ owner: "o", repo: "r", kind: "pull", number: 7 }, { exec, rest });
  assert.ok(calls.length <= 1, "no gh view attempted when gh is absent");
  assert.ok(restCalls.some(isPullComments), "REST fallback hit the API");
  assert.match(result.content, /^#7 Fix the bug/);
  assert.match(result.content, /REST fallback used/);
  assert.match(result.content, /authenticate gh for the complete view/);
});

test("issue-pr: gh view failure falls back to REST", async () => {
  const { exec } = fakeExec((command, args) => {
    if (command === "gh" && args[0] === "pr") return { code: 1, stderr: "GraphQL: Not found" };
    if (command === "gh" && args[0] === "--version") return { code: 0 };
    return { stdout: "[]" };
  });
  const { rest } = fakeRest((url) => (/\/pulls\/7$/.test(url) ? { json: restPull } : { json: [] }));
  const result = await fetchIssuePr({ owner: "o", repo: "r", kind: "pull", number: 7 }, { exec, rest });
  assert.match(result.content, /^#7 Fix the bug/);
});

test("issue-pr: rate-limited REST renders an actionable auth message", async () => {
  const { exec } = fakeExec(() => ({ code: 1 }));
  const { rest } = fakeRest((url) => (/\/pulls\/7$/.test(url) ? { status: 403 } : { json: [] }));
  const result = await fetchIssuePr({ owner: "o", repo: "r", kind: "pull", number: 7 }, { exec, rest });
  assert.match(result.content, /rate limit reached/);
  assert.match(result.content, /gh auth login/);
});

test("issue-pr: REST network failure throws for the handler's fallback chain", async () => {
  const { exec } = fakeExec(() => ({ code: 1 }));
  const rest = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };
  await assert.rejects(
    () => fetchIssuePr({ owner: "o", repo: "r", kind: "pull", number: 7 }, { exec, rest }),
    /ENOTFOUND/,
  );
});

// REST payload shaped like api.github.com; mapRestView normalizes it.
const restPull = {
  title: "Fix the bug", number: 7, state: "open", draft: false,
  user: { login: "alice" }, base: { ref: "main" }, head: { ref: "fix", repo: { owner: { login: "udit-001" } } },
  created_at: "2026-09-01T00:00:00Z", labels: [], milestone: null,
  additions: 10, deletions: 2, changed_files: 1, body: "Fixes the bug described in #5.",
  html_url: "https://github.com/o/r/pull/7", comments: 0, review_comments: 0,
};
