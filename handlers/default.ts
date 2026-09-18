import { htmlToMarkdown } from "./html.ts";
import { FetchError, defaultFetch, defineHandler, getText } from "./handler.ts";

/**
 * Catch-all: the default pipeline (GET -> pdf/llms.txt/readability).
 * Always last.
 * Dead or blocked pages get one more chance via the Wayback Machine.
 */
export const defaultHandler = defineHandler({
  name: "webpage",
  description: "Generic webpage: readable markdown; PDFs and llms.txt understood; Wayback fallback for dead pages",
  match: () => true,
  async fetch(url, ctx) {
    try {
      return await defaultFetch(url, ctx);
    } catch (err) {
      if (!(err instanceof FetchError) || ![403, 404, 410, 451].includes(err.status ?? 0)) throw err;
      try {
        const avail = JSON.parse(
          (await getText(`https://archive.org/wayback/available?url=${encodeURIComponent(url.href)}`, ctx.signal)).text,
        );
        const snap = avail?.archived_snapshots?.closest;
        if (!snap?.available) throw err;
        const page = await getText(snap.url, ctx.signal);
        const md = htmlToMarkdown(page.text);
        return {
          kind: "article",
          title: md.title,
          content: `(Wayback Machine snapshot ${snap.timestamp}; the live page returned HTTP ${err.status})\n\n${md.markdown}`,
        };
      } catch {
        throw err; // archive has nothing either; report the original failure
      }
    }
  },
});
