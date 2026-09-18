import { htmlFragmentToMarkdown } from "./html.ts";
import { FetchError, defineHandler, getJson } from "./handler.ts";

export const hackerNewsHandler = defineHandler({
  name: "hackernews",
  description: "Hacker News items: story + top comments via the Algolia API",
  match: (url) => url.hostname === "news.ycombinator.com" && url.pathname === "/item" && !!url.searchParams.get("id"),
  async fetch(url, ctx) {
    const id = url.searchParams.get("id")!;
    const d = await getJson<any>(`https://hn.algolia.com/api/v1/items/${id}`, ctx.signal);
    if (!d?.id) throw new FetchError(`HN item ${id} not found`);
    const comments: any[] = (d.children ?? []).slice(0, 10);
    const parts = [
      `# ${d.title ?? "(comment)"}`,
      `${d.points ?? 0} points | by ${d.author} | ${(d.children ?? []).length} top-level comments`,
      d.url ? `link: ${d.url}` : "",
      "",
      d.text ? htmlFragmentToMarkdown(d.text) : "",
      ...comments.map((c) => `\n---\n**${c.author}**:\n${htmlFragmentToMarkdown(c.text ?? "")}`),
    ];
    return { kind: "thread", title: d.title, content: parts.filter((p) => p !== "").join("\n") };
  },
});
