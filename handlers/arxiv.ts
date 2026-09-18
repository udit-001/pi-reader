import { decodeEntities } from "./html.ts";
import { type FetchContext, type HandlerResult, FetchError, defaultFetch, defineHandler, getText } from "./handler.ts";

/**
 * "/pdf/2301.00001v2.pdf" -> "2301.00001".
 * Both suffixes can be present, so they come off one at a time; old-style ids keep their archive prefix ("math/0309136").
 */
export function paperId(pathname: string): string {
  return paperPdfId(pathname).replace(/v\d+$/, "");
}

/** PDF endpoints are versioned; unlike the metadata API, keep an explicit vN. */
export function paperPdfId(pathname: string): string {
  return pathname.replace(/^\/(abs|pdf|html)\//, "").replace(/\.pdf$/, "");
}

async function fromExportApi(id: string, ctx: FetchContext): Promise<HandlerResult> {
  const { text: xml } = await getText(`https://export.arxiv.org/api/query?id_list=${id}`, ctx.signal);
  const entry = xml.split("<entry>")[1];
  if (!entry) throw new FetchError(`arXiv paper ${id} not found`);
  const pick = (tag: string) =>
    decodeEntities((entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").trim());
  const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
  const title = pick("title").replace(/\s+/g, " ");
  const parts = [
    `# ${title}`,
    `arXiv:${id} | ${authors.join(", ")} | published ${pick("published").slice(0, 10)}`,
    `pdf: https://arxiv.org/pdf/${id}`,
    "",
    "## Abstract",
    pick("summary").replace(/\s*\n\s*/g, " "),
  ];
  return { kind: "paper", title, content: parts.join("\n") };
}

export const arxivHandler = defineHandler({
  name: "arxiv",
  description: "arXiv papers: title, authors, abstract via the export API; full text for /pdf/ urls and full mode",
  match: (url) => /(^|\.)arxiv\.org$/.test(url.hostname) && /^\/(abs|pdf|html)\//.test(url.pathname),
  async fetch(url, ctx) {
    const id = paperId(url.pathname);

    // Asking for /pdf/ (or full mode) means the caller wants the paper, not a summary of it.
    // Metadata is a page of text; the paper is the reason the url was passed at all.
    // defaultFetch sees application/pdf and extracts.
    if (ctx.mode === "full" || /^\/pdf\//.test(url.pathname)) {
      const paper = await defaultFetch(new URL(`https://arxiv.org/pdf/${paperPdfId(url.pathname)}`), { ...ctx, mode: "light" });
      return { ...paper, kind: "paper" };
    }

    try {
      return await fromExportApi(id, ctx);
    } catch {
      // export.arxiv.org rate-limits hard and drops out for stretches, while arxiv.org itself stays up.
      // The abstract page carries the same metadata, so a failed api call is worth a second try rather than an error the model has to work around.
      return defaultFetch(new URL(`https://arxiv.org/abs/${id}`), { ...ctx, mode: "light" });
    }
  },
});
