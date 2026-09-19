import { cloneRepo, defaultFetch, defineHandler, getJson, getText } from "./handler.ts";

export const gitlabHandler = defineHandler({
  name: "gitlab",
  description: "GitLab: README+metadata (light) or shallow clone (full); raw files",
  match: (url) => /(^|\.)gitlab\.com$/.test(url.hostname),
  async fetch(url, ctx) {
    // gitlab paths can be nested groups: /group/sub/repo/-/blob/...
    const dashIdx = url.pathname.indexOf("/-/");
    const projectPath = (dashIdx === -1 ? url.pathname : url.pathname.slice(0, dashIdx))
      .replace(/^\/|\/$/g, "")
      .replace(/\.git$/, "");
    if (!projectPath.includes("/")) return defaultFetch(url, ctx);

    if (dashIdx !== -1) {
      const sub = url.pathname.slice(dashIdx + 3);
      if (sub.startsWith("blob/")) {
        const { text } = await getText(`https://gitlab.com/${projectPath}/-/raw/${sub.slice(5)}`, ctx.signal);
        return { kind: "file", content: text };
      }
      if (sub.startsWith("raw/")) {
        const { text } = await getText(url.href, ctx.signal);
        return { kind: "file", content: text };
      }
      return defaultFetch(url, ctx);
    }

    if (ctx.mode === "full") return cloneRepo(`https://gitlab.com/${projectPath}.git`, ctx);

    const api = `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectPath)}`;
    const meta = await getJson<{
      description: string | null;
      default_branch: string;
      star_count: number;
      readme_url: string | null;
    }>(api, ctx.signal);
    let readme = "(no README found)";
    if (meta.readme_url) {
      readme = (await getText(meta.readme_url.replace("/-/blob/", "/-/raw/"), ctx.signal)).text;
    }
    const header = [
      `# ${projectPath}`,
      meta.description ?? "",
      `stars: ${meta.star_count} | default branch: ${meta.default_branch}`,
    ]
      .filter(Boolean)
      .join("\n");
    return { kind: "readme", title: projectPath, content: `${header}\n\n---\n\n${readme}` };
  },
});
