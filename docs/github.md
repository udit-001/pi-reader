# GitHub rendering

Reference for `fetch/github-clone.ts` and `fetch/github-issue-pr.ts`. Open this before touching either.

## Repo checkouts (`github-clone.ts`)

- `ensureClone`: gh first (auth covers private repos), git fallback. A repo size gate runs first — over `maxRepoSizeMB` (config) → `{too-large, sizeMB, limitMB}` so the caller can say why.
- Checkouts land in `<clonePath>/runtime-<mkdtemp>/<sha256>` — `/tmp` by default, deliberately outside the LRU-evicted pi-reader cache root: a checkout deleted mid-session under the agent's `read` is worse than disk.
- The runtime cache is cross-process: owner files, stale sweeping, timeout kill discipline, traversal guards, tree caps.
- `exec` and `clonePath` are injectable — tests never touch the network or git.

## Issues and PRs (`github-issue-pr.ts`)

- URL parsing: `parseIssuePrUrl` → `{owner, repo, kind, number, anchor?}`.
- Transport: gh first (`gh pr view --json` with rich fields — auth covers private repos and lifts the 60 req/h anonymous limit). Old gh versions that reject unknown JSON fields retry with a core field set plus an availability note. gh absent or failed → api.github.com REST fallback through the SSRF-guarded `httpGet`, mapped to the same view shape.
- One deterministic renderer (`renderIssuePr`) serves both paths. Degradation is explicit — `*Unavailable` flags, availability notes, escalation commands (`gh pr view`, `gh pr diff`) — never silent omission.
- Test surface: `renderIssuePr` and `mapRestView` are pure — pin them, not the transport.
