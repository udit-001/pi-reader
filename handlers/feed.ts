// RSS/Atom feed handler — feeds as first-class fetchable objects.
//
// A feed URL (.xml/.rss/.atom, or a /feed path) returns the channel title and
// recent items as Markdown instead of a raw XML dump. Feed bodies are parsed
// with linkedom's XML DOMParser (already a dependency — no new packages).
//
// Match discipline: URL shape claims the URL, the payload confirms it — a body
// that is not a feed throws and the URL falls through to the default pipeline
// (this also keeps sitemaps and plain .xml files out of this handler).
// Bot-walled feed URLs (403/429 from the direct fetch) get one curl retry via
// the shared curl tier; genuine 404s surface as errors downstream.
//
// feedToMarkdown is the pure parse/render seam, exported for its own tests
// (not for callers).

import { DOMParser } from "linkedom";
import { curlGetText } from "../curl-fetch.ts";
import { FetchError, type FetchContext, type HandlerResult, defineHandler, getText } from "./handler.ts";

/** Minimal structural view of a parsed XML node — keeps linkedom's class types out of our interface. */
interface XmlNode {
  tagName?: string;
  textContent: string;
  documentElement?: XmlNode | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): XmlNode | null;
  querySelectorAll(selector: string): Iterable<XmlNode>;
}

const MAX_ITEMS = 20;
const BLOCKED_STATUSES = new Set([401, 403, 406, 429, 503]);

/** URL-shape check: which paths this handler claims (sitemap never is a feed). */
export function matchFeedPath(url: URL): boolean {
  if (/sitemap/i.test(url.pathname)) return false;
  return /\.(xml|rss|atom)$/i.test(url.pathname) || /\/feed\/?$/i.test(url.pathname);
}

export interface FeedContent {
  title: string;
  content: string;
}

const FORMAT_LABEL: Record<string, string> = { rss: "RSS", feed: "Atom", rdf: "RDF" };

/** Pure parse/render seam: feed XML → channel header + recent items in Markdown. */
export function feedToMarkdown(xml: string): FeedContent | null {
  let doc: XmlNode;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as XmlNode;
  } catch {
    return null;
  }
  const root = doc.documentElement?.tagName?.toLowerCase() ?? "";
  if (!(root in FORMAT_LABEL)) return null;
  const isAtom = root === "feed";
  const scope = isAtom ? "feed" : "channel";

  const channelTitle = doc.querySelector(`${scope} > title`)?.textContent?.trim() ?? "";
  const siteLink = pickChannelLink([...doc.querySelectorAll(`${scope} > link`)]);
  const description = doc.querySelector(isAtom ? "feed > subtitle" : "channel > description")?.textContent?.trim() ?? "";
  const lastBuild = doc.querySelector(isAtom ? `${scope} > updated` : `${scope} > lastbuilddate, ${scope} > lastbuilddate`)?.textContent?.trim() ?? "";

  const items = [...doc.querySelectorAll(isAtom ? "entry" : "item")];
  const total = items.length;
  const lines: string[] = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    const title = item.querySelector("title")?.textContent?.trim() ?? "(untitled)";
    const link = pickItemLink(item);
    const date = item.querySelector("pubdate, pubDate, published, updated")?.textContent?.trim() ?? "";
    const bits = [link ? `[${title}](${link})` : title];
    if (date) bits.push(date);
    lines.push(`- ${bits.join(" -- ")}`);
  }

  const head = [`# ${channelTitle || "Feed"} (${FORMAT_LABEL[root] ?? root} feed)`];
  if (description) head.push(description);
  if (siteLink) head.push(`Site: ${siteLink}`);
  if (lastBuild) head.push(`Last build: ${lastBuild}`);
  if (total > 0) head.push(``, `Recent items (showing ${Math.min(total, MAX_ITEMS)} of ${total}):`);

  const content = [...head, ...lines].join("\n").trim();
  if (!content) return null;
  return { title: channelTitle || "Feed", content };
}

/** Channel-level site link: prefer rel=alternate, then a non-self href, then link text. */
function pickChannelLink(links: XmlNode[]): string {
  const alternate = links.find((l) => l.getAttribute("rel") === "alternate");
  if (alternate?.getAttribute("href")) return alternate.getAttribute("href")!;
  const nonSelf = links.find((l) => (l.getAttribute("rel") ?? "alternate") !== "self" && l.getAttribute("href"));
  if (nonSelf?.getAttribute("href")) return nonSelf.getAttribute("href")!;
  return links.map((l) => l.textContent?.trim() ?? "").find(Boolean) ?? "";
}

/** Item link: Atom prefers rel=alternate / first non-self href; RSS uses <link> text. */
function pickItemLink(item: XmlNode): string {
  const links = [...item.querySelectorAll("link")];
  const atomHref = links.find((l) => l.getAttribute("rel") === "alternate" || l.getAttribute("rel") === "")
    ?? links.find((l) => !l.getAttribute("rel") && l.getAttribute("href"));
  if (atomHref?.getAttribute("href")) return atomHref.getAttribute("href")!;
  return links.map((l) => l.textContent?.trim() ?? "").find(Boolean) ?? "";
}

export const feedHandler = defineHandler({
  name: "feed",
  description: "RSS/Atom feeds: channel title + recent items as Markdown",
  match: (url) => url.protocol === "https:" && matchFeedPath(url),
  async fetch(url, ctx: FetchContext): Promise<HandlerResult> {
    let xml: string;
    try {
      xml = (await getText(url.href, ctx.signal)).text;
    } catch (err) {
      const status = err instanceof FetchError ? err.status : undefined;
      if (status !== undefined && BLOCKED_STATUSES.has(status)) {
        const curl = await curlGetText(url.href, { signal: ctx.signal, timeoutMs: 30_000 });
        if (curl && curl.status === 200 && curl.text.trim()) {
          xml = curl.text;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const feed = feedToMarkdown(xml);
    if (!feed) throw new FetchError(`Not a feed: ${url.href}`);
    return { kind: "feed", title: feed.title, content: feed.content };
  },
});
