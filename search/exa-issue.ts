// exa-issue.ts — a handoff between the adapter and the entry, so neither depends
// on the other. Two kinds, because the recovery differs: rate-limited (the key
// works; wait or replace it) and missing-key (nothing valid is configured).

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
