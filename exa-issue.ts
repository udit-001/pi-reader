// exa-issue.ts — why the Exa setup wizard might be needed.
//
// Tiny shared module so the adapter (exa-mcp.ts) can record what went wrong
// and the entry point (index.ts) can surface a one-shot hint, without either
// depending on the other. Two failure kinds matter because recovery differs:
//   rate-limited — the key works; wait, or replace it
//   missing-key  — nothing valid is configured; set one up

export type ExaIssue = "rate-limited" | "missing-key";

let pending: ExaIssue | null = null;

export function noteExaIssue(issue: ExaIssue): void {
  pending = issue;
}

export function consumeExaIssue(): ExaIssue | null {
  const issue = pending;
  pending = null;
  return issue;
}

// Map an Exa error message to the issue it indicates, or null if it's just a
// transient failure not worth a setup hint. Rate-limit patterns are checked
// first so a 403-that-really-means-quota isn't misread as a bad key.
export function classifyExaError(message: string): ExaIssue | null {
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(message)) return "rate-limited";
  if (/\b40[13]\b|no exa.*api key|unauthorized|invalid api key|forbidden/i.test(message)) return "missing-key";
  return null;
}
