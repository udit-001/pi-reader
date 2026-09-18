import {
  FetchError,
  type FetchContext,
  type HandlerResult,
  cloneRepo,
  defaultFetch,
  defineHandler,
  getJson,
  getText,
} from "./handler.ts";

function repoParts(url: URL): { owner: string; repo: string; rest: string[] } | undefined {
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  const owner = segs[0] ?? "";
  const repo = (segs[1] ?? "").replace(/\.git$/, "");
  return { owner, repo, rest: segs.slice(2) };
}

interface GhRepoMeta {
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  language: string | null;
}

async function githubLight(owner: string, repo: string, ctx: FetchContext): Promise<HandlerResult> {
  let header = `# ${owner}/${repo}`;
  let readme: string | undefined;
  try {
    const meta = await getJson<GhRepoMeta>(`https://api.github.com/repos/${owner}/${repo}`, ctx.signal);
    header = [
      `# ${meta.full_name}`,
      meta.description ?? "",
      `stars: ${meta.stargazers_count} | language: ${meta.language ?? "?"} | default branch: ${meta.default_branch}`,
    ]
      .filter(Boolean)
      .join("\n");
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
  if (!readme) throw new FetchError(`Could not fetch README for ${owner}/${repo}; try mode "full" to clone`);
  return { kind: "readme", title: `${owner}/${repo}`, content: `${header}\n\n---\n\n${readme}` };
}

interface GhIssue {
  title: string;
  state: string;
  user: { login: string };
  body: string | null;
}

async function githubIssue(owner: string, repo: string, num: string, ctx: FetchContext): Promise<HandlerResult> {
  const issue = await getJson<GhIssue>(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, ctx.signal);
  const comments = await getJson<Array<{ user: { login: string }; body: string }>>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments?per_page=20`,
    ctx.signal,
  );
  const parts = [
    `# ${issue.title} (#${num}, ${issue.state})`,
    `by ${issue.user.login} | ${owner}/${repo}`,
    "",
    issue.body ?? "(no description)",
    ...comments.map((c) => `\n---\n**${c.user.login}:**\n${c.body}`),
  ];
  return { kind: "issue", title: issue.title, content: parts.join("\n") };
}

export const githubHandler = defineHandler({
  name: "github",
  description: "GitHub: README+metadata (light) or shallow clone (full); raw files, issues, PRs",
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
      const { text } = await getText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${rest.slice(1).join("/")}`,
        ctx.signal,
      );
      return { kind: "file", content: text };
    }
    if ((rest[0] === "issues" || rest[0] === "pull") && /^\d+$/.test(rest[1] ?? "")) {
      return githubIssue(owner, repo, rest[1] ?? "", ctx);
    }
    if (rest.length === 0 || rest[0] === "tree") {
      return ctx.mode === "full"
        ? cloneRepo(`https://github.com/${owner}/${repo}.git`, ctx)
        : githubLight(owner, repo, ctx);
    }
    return defaultFetch(url, ctx); // releases, actions, wiki, ... : plain page
  },
});
