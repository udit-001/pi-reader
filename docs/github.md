# GitHub rendering

Reference for `fetch/github-clone.ts` and `fetch/github-issue-pr.ts`. The flow is readable in the code; what follows is the part it does not confess.

## Repo checkouts

- **Probe auth, not presence.** A logged-out gh passes `--version` and fails every call, so gh is chosen only when `gh auth status` succeeds; git is the fallback. Choosing on presence drops public repos to the API view.
- **The size gate measures the checkout, not the repo.** It sums the ref's working-tree blobs (`git/trees?recursive=1`, doubled for the object store) because the whole-repo `size` counts every commit in history and refused popular repos whose shallow clone is tiny. A truncated listing falls back to that coarser number.
- **The longest ref that prefixes the path wins.** GitHub's own rule, and the only way `feature/x` is not misread as `ref=feature, path=x/src` — a misread fails the clone and silently drops to the API view. Tree segments are percent-decoded before ref resolution and filesystem use; the `blob`/`raw` branch stays encoded, which is what raw.githubusercontent wants.
- **A commit SHA is a dead end for a clone,** so it gets a note naming the branch URL as the recovery rather than a raw `--branch` error.
- **Transient transport drops get one retry;** a mid-pack disconnect (`unexpected disconnect`, `early EOF`, `RPC failed`, resets — `TRANSIENT_CLONE_RE`) reruns the clone once before the handler degrades to the API view, because the first attempt failing on a media-heavy repo is usually momentary. A timeout kill (`code null`) and permanent errors (`repository not found`) never retry — the budget is spent or the error cannot succeed. A timeout kill's stderr is not trusted as the reason (a killed pack read prints `unexpected disconnect…`, which reads as a network error when the network is fine): the note names the timeout and the recovery (re-fetch, or raise `githubClone.cloneTimeout`, default 120s). A retried failure says so: `retried once, still failing: …`, so the agent-facing note doesn't invite a third attempt.
- **Checkouts land outside the cache root,** in `/tmp` by default: an evicted clone pulled out from under the agent's next `read` is worse than disk. A checkout is re-validated on every read, so one removed mid-session (a /tmp cleaner) is re-cloned instead of returning a dead path. The root render names it **shallow**, so an empty `git log`/`blame` is explained where the agent sees it.
- **Submodules initialize best-effort** and only when the repo declares `.gitmodules`. A failure leaves an empty directory and sets `submodulesIncomplete` so the render can say so; `--recurse-submodules` on the clone would trade a usable checkout for an API view.
- **Symlinks are listed, never walked through** — to an ancestor they loop, to a sibling they duplicate that subtree. The exception is the path the agent names: it resolves once, so a symlink to a directory lists that directory.
- **`GIT_LFS_SKIP_SMUDGE=1` on every subprocess** (in `transportEnv`, pure and tested): a clone must not pull LFS objects the size gate cannot see.

## Issues and PRs

- **gh first, REST fallback.** Auth covers private repos and lifts the 60 req/h anonymous limit; api.github.com through the SSRF-guarded `httpGet` serves the rest. An old gh that rejects unknown `--json` fields retries with a core field set plus an availability note, rather than failing the fetch.
- **One renderer (`renderIssuePr`) serves both transports** and degrades explicitly: `*Unavailable` flags, availability notes, escalation commands (`gh pr view`, `gh pr diff`). Silent omission is the failure mode worth naming — a missing section must read as missing, not as absent from the PR.
- Test surface: `renderIssuePr` and `mapRestView` are pure. Pin them, not the transport.
