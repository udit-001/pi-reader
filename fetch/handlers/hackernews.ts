import { htmlFragmentToMarkdown } from "./html.ts";
import {
  FetchError,
  type FetchContext,
  type HandlerResult,
  defineHandler,
  getJson,
} from "./handler.ts";

// Pure routing seam — internal, exported for its own tests (not for callers):
// the single source of truth for which news.ycombinator.com listing paths this
// handler serves, and the one Algolia query that backs each. Without it the
// agent answers "latest Show HN posts" with raw Firebase API calls via shell.
export interface HnListingQuery {
  /** Algolia endpoint: relevance-ranked (front page) vs newest-first (categories). */
  endpoint: "search" | "search_by_date";
  tags: string;
  label: string;
}

export function listingQuery(pathname: string): HnListingQuery | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/news") return { endpoint: "search", tags: "front_page", label: "front page" };
  if (path === "/newest") return { endpoint: "search_by_date", tags: "story", label: "newest stories" };
  if (path === "/show") return { endpoint: "search_by_date", tags: "show_hn", label: "Show HN" };
  if (path === "/ask") return { endpoint: "search_by_date", tags: "ask_hn", label: "Ask HN" };
  if (path === "/jobs") return { endpoint: "search_by_date", tags: "job", label: "jobs" };
  return undefined;
}

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  author: string | null;
  num_comments: number | null;
  created_at: string | null;
}

// Pure formatting seam — internal, exported for its own tests (not for callers).
export function formatStories(hits: AlgoliaHit[]): string {
  if (hits.length === 0) return "No stories found.";
  return hits
    .map((h, i) => {
      const link = h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
      const facts = [
        `${h.points ?? 0} points`,
        `${h.num_comments ?? 0} comments`,
        ...(h.author ? [`by ${h.author}`] : []),
        ...(h.created_at ? [h.created_at.slice(0, 10)] : []),
      ].join(" | ");
      return [`${i + 1}. ${h.title ?? "(untitled)"}`, `   ${link}`, `   ${facts}`].join("\n");
    })
    .join("\n");
}

async function hnListing(q: HnListingQuery, ctx: FetchContext): Promise<HandlerResult> {
  const d = await getJson<{ hits: AlgoliaHit[] }>(
    `https://hn.algolia.com/api/v1/${q.endpoint}?tags=${q.tags}&hitsPerPage=30`,
    ctx.signal,
  );
  return { kind: "listing", title: `Hacker News — ${q.label}`, content: formatStories(d.hits ?? []) };
}

export const hackerNewsHandler = defineHandler({
  name: "hackernews",
  description:
    "Hacker News: item URLs return story + top comments; listing pages (front page, /newest, /show, /ask, /jobs) return the current story list — via the Algolia API",
  match: (url) =>
    url.hostname === "news.ycombinator.com" &&
    (listingQuery(url.pathname) !== undefined ||
      (url.pathname === "/item" && !!url.searchParams.get("id"))),
  async fetch(url, ctx) {
    const listing = listingQuery(url.pathname);
    if (listing) return hnListing(listing, ctx);
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
