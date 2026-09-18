import { htmlToMarkdown } from "./html.ts";
import { FetchError, defineHandler, getText } from "./handler.ts";

export const redditHandler = defineHandler({
  name: "reddit",
  description: "Reddit threads: post + top comments via the public .json endpoint",
  match: (url) => /(^|\.)reddit\.com$/.test(url.hostname) && url.pathname.includes("/comments/"),
  async fetch(url, ctx) {
    const BROWSER_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    let text: string;
    try {
      text = (await getText(`https://www.reddit.com${url.pathname.replace(/\/$/, "")}.json?raw_json=1`, ctx.signal)).text;
    } catch {
      // Reddit 403s .json on many networks but serves HTML; readability the page instead
      const page = await getText(`https://old.reddit.com${url.pathname}`, ctx.signal, { "user-agent": BROWSER_UA });
      const md = htmlToMarkdown(page.text);
      return { kind: "thread", title: md.title, content: md.markdown };
    }
    const [postListing, commentListing] = JSON.parse(text);
    const post = postListing?.data?.children?.[0]?.data;
    if (!post) throw new FetchError(`Could not parse reddit thread at ${url.href}`);
    const comments: any[] = (commentListing?.data?.children ?? []).filter((c: any) => c.kind === "t1").slice(0, 10);
    const parts = [
      `# ${post.title}`,
      `r/${post.subreddit} | ${post.score} points | ${post.num_comments} comments | u/${post.author}`,
      post.url && !post.is_self ? `link: ${post.url}` : "",
      "",
      post.selftext || "(link post)",
      ...comments.map((c: any) => `\n---\n**u/${c.data.author}** (${c.data.score} points):\n${c.data.body ?? ""}`),
    ];
    return { kind: "thread", title: post.title, content: parts.filter((p) => p !== "").join("\n") };
  },
});
