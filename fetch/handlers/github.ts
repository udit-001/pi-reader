import {
  FetchError,
  type FetchContext,
  type HandlerResult,
  defaultFetch,
  defineHandler,
  getJson,
  getText,
} from "./handler.ts";
import { ensureClone, FULL_SHA_RE, renderRepoView, resolveTreePath, SHA_LIKE_RE } from "../github-clone.ts";
import { fetchIssuePr, parseIssuePrUrl } from "../github-issue-pr.ts";

function repoParts(url: URL): { owner: string; repo: string; rest: string[] } | undefined {
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  const owner = segs[0] ?? "";
  const repo = (segs[1] ?? "").replace(/\.git$/, "");
  return { owner, repo, rest: segs.slice(2) };
}

/** URL path segments arrive percent-encoded; a space or non-ASCII path must
 *  reach the filesystem decoded. Pure; exported for tests. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed escape: leave it as the URL wrote it
  }
}

/** The raw-content URL for a `blob`/`raw` path. Segments stay percent-encoded —
 *  raw.githubusercontent wants the path as the URL wrote it. Pure; exported
 *  for tests, which pin that the tree branch's decode does not reach here. */
export function rawContentUrl(owner: string, repo: string, rest: string[]): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.slice(1).join("/")}`;
}

interface GhRepoMeta {
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  license: { spdx_id: string | null } | null;
  homepage: string | null;
  topics: string[] | null;
  archived: boolean;
  pushed_at: string | null;
}

// Pure formatting seam — internal, exported for its own tests (not for
// callers): one compact block that carries everything the repos API returned.
// The output IS the tool's real description — an under-rendered header reads
// as "the fetch tool can't do details" and pushes the agent toward raw API
// calls.
export function repoHeader(meta: GhRepoMeta): string {
  const spdx = meta.license?.spdx_id;
  const facts = [
    `stars: ${meta.stargazers_count}`,
    `forks: ${meta.forks_count}`,
    `language: ${meta.language ?? "?"}`,
    `default branch: ${meta.default_branch}`,
    ...(spdx && spdx !== "NOASSERTION" && spdx !== "OTHER" ? [`license: ${spdx}`] : []),
  ].join(" | ");
  const lines = [
    `# ${meta.full_name}`,
    meta.description ?? "",
    facts,
    ...(meta.homepage ? [`homepage: ${meta.homepage}`] : []),
    ...(meta.topics?.length ? [`topics: ${meta.topics.join(", ")}`] : []),
    ...(meta.archived ? ["ARCHIVED"] : []),
    ...(meta.pushed_at ? [`last push: ${meta.pushed_at}`] : []),
  ];
  return lines.filter(Boolean).join("\n");
}

async function githubLight(owner: string, repo: string, ctx: FetchContext): Promise<HandlerResult> {
  let header = `# ${owner}/${repo}`;
  let readme: string | undefined;
  try {
    const meta = await getJson<GhRepoMeta>(`https://api.github.com/repos/${owner}/${repo}`, ctx.signal);
    header = repoHeader(meta);
    const res = await getText(`https://api.github.com/repos/${owner}/${repo}/readme`, ctx.signal, {
      accept: "application/vnd.github.raw+json",
    });
    readme = res.text;
  } catch {
    // API rate-limited or private: fall back to raw README guesses
    for (const ref of ["HEAD", "main", "master"]) {
      try {
        readme = (await getText(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/README.md`, ctx.signal)).text;
        break;
      } catch {
        // try next ref
      }
    }
  }
  if (!readme) {
    throw new FetchError(
      `Could not fetch README for ${owner}/${repo} — the repo may be private, rate-limited, or have no README`,
    );
  }
  return { kind: "readme", title: `${owner}/${repo}`, content: `${header}\n\n---\n\n${readme}` };
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  prerelease: boolean;
  body: string | null;
  assets: Array<{ name: string; size: number }>;
}

const RELEASE_NOTES_CAP = 2000;

// Pure formatting seam — internal, exported for its own tests (not for callers).
export function formatRelease(r: GhRelease): string {
  const head = [
    `## ${r.name || r.tag_name} (${r.tag_name})`,
    `published: ${r.published_at ?? "unknown"}${r.prerelease ? " | pre-release" : ""}`,
  ].join("\n");
  const assets = r.assets.length
    ? r.assets.map((a) => `  ${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`).join("\n")
    : "";
  const notes = r.body ? `\n${r.body.trim().slice(0, RELEASE_NOTES_CAP)}${r.body.length > RELEASE_NOTES_CAP ? "\n[...truncated...]" : ""}` : "";
  return [head, assets, notes].filter(Boolean).join("\n");
}

export function formatReleases(releases: GhRelease[]): string {
  if (releases.length === 0) return "No releases found.";
  return releases.map(formatRelease).join("\n\n---\n\n");
}

// Which releases call to make, derived from the URL path segments after
// owner/repo. Pure routing seam — internal, exported for its own tests (not
// for callers) — and the single source of truth for which /releases/... shapes
// this handler serves; fetch() and githubReleases() both go through it.
export type ReleasesIntent = { kind: "list" } | { kind: "single"; apiPath: string };

export function parseReleasesPath(rest: string[]): ReleasesIntent | undefined {
  if (rest[0] !== "releases") return undefined;
  if (rest.length === 1) return { kind: "list" };
  if (rest[1] === "latest") return { kind: "single", apiPath: "latest" };
  const tag = rest[2];
  if (rest[1] === "tag" && tag) return { kind: "single", apiPath: `tags/${tag}` };
  return undefined; // other /releases/... subpaths: plain page
}

async function githubReleases(
  owner: string,
  repo: string,
  ctx: FetchContext,
  intent: ReleasesIntent,
): Promise<HandlerResult> {
  const base = `https://api.github.com/repos/${owner}/${repo}/releases`;
  if (intent.kind === "single") {
    const release = await getJson<GhRelease>(`${base}/${intent.apiPath}`, ctx.signal);
    return {
      kind: "release",
      title: `Release ${release.tag_name} of ${owner}/${repo}`,
      content: formatReleases([release]),
    };
  }
  const releases = await getJson<GhRelease[]>(`${base}?per_page=10`, ctx.signal);
  return { kind: "release", title: `Releases of ${owner}/${repo}`, content: formatReleases(releases) };
}

// Full-SHA refs can't be branch-cloned; they get the API view with a note.

function withNote(light: HandlerResult, note: string): HandlerResult {
  return { ...light, content: `${light.content}\n\n---\n\n${note}` };
}

/** Agent-facing: why a commit-SHA URL has no checkout, and what to use instead. */
const SHA_NOTE =
  "Note: commit-SHA URLs show the API view — a clone needs a branch name. " +
  "Use a branch URL (`/tree/<branch>/…`) for a local checkout.";

/** The note for a clone that could not run. A SHA-shaped ref gets the same
 *  explanation the full-SHA shortcut gives: `--branch` takes a branch name, and
 *  a short or uppercase SHA is not one. Pure; exported for tests. */
export function cloneFailureNote(ref: string | undefined, reason: string): string {
  return ref && SHA_LIKE_RE.test(ref) ? SHA_NOTE : `Note: clone failed (${reason}) — showing the API view instead.`;
}

/** Issue/PR URL: delegate to the github-issue-pr module (gh-first, REST fallback). */
function githubIssueView(url: URL, ctx: FetchContext): Promise<HandlerResult> | undefined {
  const info = parseIssuePrUrl(url);
  if (!info) return undefined; // odd subpath — plain page
  return fetchIssuePr(info, { signal: ctx.signal });
}

/**
 * Repo root / tree URL: clone the checkout (github-clone.ts) and point the
 * agent at the local path. Degrades gracefully — oversized or failed clones
 * fall back to the API view, so the worst case is the pre-clone behavior.
 */
async function githubRepoClone(
  owner: string,
  repo: string,
  ref: string | undefined,
  subPath: string,
  ctx: FetchContext,
): Promise<HandlerResult> {
  if (ref && FULL_SHA_RE.test(ref)) {
    const light = await githubLight(owner, repo, ctx);
    return withNote(light, SHA_NOTE);
  }
  const result = await ensureClone({ owner, repo, ref }, { signal: ctx.signal });
  if (result.status === "cloned") {
    const view: HandlerResult = {
      kind: "repo",
      title: subPath ? `${owner}/${repo} - ${subPath}` : `${owner}/${repo}`,
      content: renderRepoView(result.localPath, subPath ? { type: "tree", path: subPath } : { type: "root" }),
    };
    return result.submodulesIncomplete
      ? withNote(view, "Note: some submodules could not be fetched — their directories are empty or missing; `git submodule update --init --recursive` at the path above retries.")
      : view;
  }
  if (result.status === "disabled") return githubLight(owner, repo, ctx); // config off: today's behavior
  if (result.status === "too-large") {
    const light = await githubLight(owner, repo, ctx);
    return withNote(
      light,
      `Note: the checkout is ~${Math.round(result.sizeMB)} MB (limit: ${result.limitMB} MB) — showing the API view instead of cloning.`,
    );
  }
  const light = await githubLight(owner, repo, ctx);
  return withNote(light, cloneFailureNote(ref, result.reason));
}

export const githubHandler = defineHandler({
  name: "github",
  description:
    "GitHub: repo URLs return a local clone or API view; releases, raw files, and rich " +
    "issue/PR documents (gh-first, REST fallback)",
  match: (url) =>
    /(^|\.)github\.com$/.test(url.hostname) ||
    url.hostname === "raw.githubusercontent.com" ||
    url.hostname === "gist.github.com",
  async fetch(url, ctx) {
    if (url.hostname === "raw.githubusercontent.com") {
      const { text } = await getText(url.href, ctx.signal);
      return { kind: "file", content: text };
    }
    const p = repoParts(url);
    if (!p || url.hostname === "gist.github.com") return defaultFetch(url, ctx);
    const { owner, repo, rest } = p;

    if (rest[0] === "blob" || rest[0] === "raw") {
      const { text } = await getText(rawContentUrl(owner, repo, rest), ctx.signal);
      return { kind: "file", content: text };
    }
    if ((rest[0] === "issues" || rest[0] === "pull") && /^\d+$/.test(rest[1] ?? "")) {
      const view = githubIssueView(url, ctx);
      if (view) return view;
      return defaultFetch(url, ctx); // unrecognized shape — plain page
    }
    if (rest.length === 0 || rest[0] === "tree") {
      // Segments are percent-encoded; both the ref list and the filesystem
      // match decoded text. A tree URL's ref may contain "/" — resolveTreePath
      // owns the split.
      const segments = rest.slice(1).map(decodeSegment);
      const { ref, subPath } = rest[0] === "tree"
        ? await resolveTreePath(owner, repo, segments, { signal: ctx.signal })
        : { ref: undefined, subPath: "" };
      return githubRepoClone(owner, repo, ref, subPath, ctx);
    }
    const releasesIntent = parseReleasesPath(rest);
    if (releasesIntent) return githubReleases(owner, repo, ctx, releasesIntent);
    return defaultFetch(url, ctx); // actions, wiki, other release subpaths, ... : plain page
  },
});
