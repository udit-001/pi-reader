import { FetchError, defineHandler, getJson } from "./handler.ts";

/** Wikipedia via the action API's plaintext extracts, no HTML round-trip at all. */
export const wikipediaHandler = defineHandler({
  name: "wikipedia",
  description: "Wikipedia articles as plaintext extracts; Wikidata entities as structured summaries",
  match: (url) =>
    /(^|\.)wikipedia\.org$/.test(url.hostname) || /(^|\.)wikidata\.org$/.test(url.hostname),
  async fetch(url, ctx) {
    if (/wikidata\.org$/.test(url.hostname)) {
      const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
      if (!/^[QPL]\d+$/.test(id)) throw new FetchError(`Not a Wikidata entity URL: ${url.href}`);
      const d = await getJson<any>(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, ctx.signal);
      const e = d.entities?.[id];
      const label = e?.labels?.en?.value ?? id;
      const lines = [
        `# ${label} (${id})`,
        e?.descriptions?.en?.value ?? "",
        "",
        `aliases: ${(e?.aliases?.en ?? []).map((a: any) => a.value).join(", ") || "-"}`,
        `claims: ${Object.keys(e?.claims ?? {}).length} properties`,
        `sitelinks: ${Object.keys(e?.sitelinks ?? {}).length}`,
        e?.sitelinks?.enwiki ? `enwiki: https://en.wikipedia.org/wiki/${encodeURIComponent(e.sitelinks.enwiki.title)}` : "",
      ];
      return { kind: "entity", title: label, content: lines.filter(Boolean).join("\n") };
    }

    if (!url.pathname.startsWith("/wiki/")) {
      throw new FetchError(`Not an article URL: ${url.href}`);
    }
    const lang = url.hostname.split(".")[0] === "www" ? "en" : url.hostname.split(".")[0];
    const title = decodeURIComponent(url.pathname.slice("/wiki/".length));
    const api = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
    const d = await getJson<any>(api, ctx.signal);
    const page = d.query?.pages?.[0];
    if (!page || page.missing) throw new FetchError(`Wikipedia article not found: ${title}`);
    return {
      kind: "article",
      title: page.title,
      content: `# ${page.title}\n\n${page.extract ?? "(empty article)"}`,
    };
  },
});
