import { decodeEntities, htmlFragmentToMarkdown } from "./html.ts";
import { FetchError, defineHandler, getJson } from "./handler.ts";

const SE_SITES: Record<string, string> = {
  "stackoverflow.com": "stackoverflow",
  "superuser.com": "superuser",
  "serverfault.com": "serverfault",
  "askubuntu.com": "askubuntu",
};

export const stackExchangeHandler = defineHandler({
  name: "stackexchange",
  description: "Stack Overflow / Stack Exchange: question + top answers via the SE API",
  match: (url) => {
    const host = url.hostname.replace(/^www\./, "");
    return (host in SE_SITES || host.endsWith(".stackexchange.com")) && /^\/(questions|q)\/\d+/.test(url.pathname);
  },
  async fetch(url, ctx) {
    const host = url.hostname.replace(/^www\./, "");
    const site = SE_SITES[host] ?? host.replace(".stackexchange.com", "");
    const id = url.pathname.match(/\/(?:questions|q)\/(\d+)/)![1];
    const api = `https://api.stackexchange.com/2.3/questions/${id}`;
    const q = (await getJson<any>(`${api}?site=${site}&filter=withbody`, ctx.signal)).items?.[0];
    if (!q) throw new FetchError(`Question ${id} not found on ${site}`);
    const answers: any[] =
      (await getJson<any>(`${api}/answers?site=${site}&filter=withbody&sort=votes&pagesize=5`, ctx.signal)).items ?? [];
    // accepted answer first, then by votes
    answers.sort((a, b) => Number(b.is_accepted) - Number(a.is_accepted) || b.score - a.score);
    const parts = [
      `# ${decodeEntities(q.title)}`,
      `${q.score} votes | ${q.answer_count} answers | asked by ${q.owner?.display_name ?? "?"} | ${site}`,
      "",
      htmlFragmentToMarkdown(q.body ?? ""),
      ...answers.map(
        (a) =>
          `\n---\n## Answer (${a.score} votes${a.is_accepted ? ", accepted" : ""}) by ${a.owner?.display_name ?? "?"}\n\n${htmlFragmentToMarkdown(a.body ?? "")}`,
      ),
    ];
    return { kind: "qa", title: decodeEntities(q.title), content: parts.join("\n") };
  },
});
