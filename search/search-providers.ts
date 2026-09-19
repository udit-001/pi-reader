import { parseHTML } from "linkedom";
import { decodeEntities } from "../fetch/handlers/html.ts";
import { getJson, getText } from "../fetch/handlers/handler.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  source: string;
}

export type SearchSource = "ddg" | "wikipedia" | "hn" | "context7";

/** Exported separately so the parser is testable offline. */
export function parseDdgLite(html: string): SearchResult[] {
  const { document } = parseHTML(html);
  const links = Array.from(document.querySelectorAll("a")).filter((a: any) => {
    const href = a.getAttribute("href") ?? "";
    return href.includes("uddg=") || /^https?:\/\//.test(href);
  });
  const snippets = Array.from(document.querySelectorAll("td.result-snippet")).map((td: any) =>
    (td.textContent ?? "").trim(),
  );
  const results: SearchResult[] = [];
  for (const a of links as any[]) {
    let href: string = a.getAttribute("href") ?? "";
    const m = href.match(/uddg=([^&]+)/);
    if (m?.[1]) href = decodeURIComponent(m[1]);
    if (!/^https?:\/\//.test(href)) continue;
    if (/duckduckgo\.com/.test(href)) continue; // ads / internal
    const title = decodeEntities((a.textContent ?? "").trim());
    if (!title) continue;
    results.push({ title, url: href, snippet: snippets[results.length], source: "ddg" });
    if (results.length >= 8) break;
  }
  return results;
}

async function searchDdg(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const { text } = await getText(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    signal,
  );
  return parseDdgLite(text);
}

async function searchWikipedia(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const d = await getJson<any>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=8&format=json&formatversion=2&srsearch=${encodeURIComponent(query)}`,
    signal,
  );
  return (d.query?.search ?? []).map((s: any) => ({
    title: s.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`,
    snippet: decodeEntities(String(s.snippet ?? "").replace(/<[^>]+>/g, "")),
    source: "wikipedia",
  }));
}

async function searchHn(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const d = await getJson<any>(
    `https://hn.algolia.com/api/v1/search?hitsPerPage=8&query=${encodeURIComponent(query)}`,
    signal,
  );
  return (d.hits ?? [])
    .filter((h: any) => h.title)
    .map((h: any) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments | https://news.ycombinator.com/item?id=${h.objectID}`,
      source: "hn",
    }));
}

/** Exported separately so the mapping is testable offline. */
export function parseContext7(payload: unknown): SearchResult[] {
  const rows = (payload as { results?: unknown[] })?.results ?? [];
  const out: SearchResult[] = [];
  for (const row of rows as Array<Record<string, any>>) {
    // An id is the doc path; without snippets there is nothing to fetch.
    if (typeof row?.id !== "string" || !(row.totalSnippets > 0)) continue;
    out.push({
      title: String(row.title ?? row.id),
      // The plaintext API, not the human page: the site itself renders through javascript, while this returns docs the default handler stores as-is.
      url: `https://context7.com/api/v1${row.id}?type=txt`,
      snippet: [row.description, `${row.totalSnippets} snippets`, row.trustScore ? `trust ${row.trustScore}` : ""]
        .filter(Boolean)
        .join(" | "),
      source: "context7",
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Library documentation by name.
 * Context7 indexes versioned docs for thousands of libraries and answers without an API key, which keeps our no-key rule intact.
 * Narrower than the others, so the model should ask for it by name when it wants API docs rather than pages about a library.
 */
async function searchContext7(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  return parseContext7(
    await getJson<unknown>(`https://context7.com/api/v1/search?query=${encodeURIComponent(query)}`, signal),
  );
}

const SOURCES: Record<SearchSource, (q: string, s?: AbortSignal) => Promise<SearchResult[]>> = {
  ddg: searchDdg,
  wikipedia: searchWikipedia,
  hn: searchHn,
  context7: searchContext7,
};

export interface SearchOutcome {
  results: SearchResult[];
  errors: string[];
}

/**
 * auto: ddg first (broadest), then wikipedia, then hn, then context7; stop at the first source that returns anything.
 * All are rate-limited free endpoints; failures are expected and reported, not fatal.
 *
 * context7 sits last because it only knows libraries, so on a general query it would answer confidently and wrongly.
 * It earns the last slot by being the steadiest of the four: when the other three are down it still replies.
 * Ask for it by name to search library docs directly.
 */
export async function webSearch(
  query: string,
  source: SearchSource | "auto",
  signal?: AbortSignal,
  onSource?: (source: SearchSource) => void,
): Promise<SearchOutcome> {
  const order: SearchSource[] = source === "auto" ? ["ddg", "wikipedia", "hn", "context7"] : [source];
  const errors: string[] = [];
  for (const s of order) {
    onSource?.(s);
    try {
      const results = await SOURCES[s](query, signal);
      if (results.length > 0) return { results, errors };
      errors.push(`${s}: no results`);
    } catch (e) {
      errors.push(`${s}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results: [], errors };
}

export function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title} [${r.source}]`, `   ${r.url}`];
      if (r.snippet) lines.push(`   ${r.snippet}`);
      return lines.join("\n");
    })
    .join("\n");
}
