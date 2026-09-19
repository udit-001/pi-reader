// Exa MCP adapter — the second real adapter at the SearchProvider seam.
//
// Policy layered over the shared MCP client glue (mcp-client.ts): a lazy
// singleton client over StreamableHTTP, kept alive for the process lifetime,
// with one reconnect-and-retry on connection failure. Tool-level errors
// (McpToolError) are never retried — a rate-limited or invalid key won't heal
// by reconnecting.
//
// Credentials come from pi-reader's own config (~/.pi/agent/pi-reader.json, written
// by /exa-setup) with the EXA_API_KEY env var as fallback. mcp.json is not
// read here — the wizard's opt-in import and the dedup detector own that file.
//
// Response parsing is hidden behind two small functions: searchExaMcp and
// searchExaAdvanced. Everything else (client lifecycle, result extraction,
// sanitizing) is implementation detail.

import type { Client } from "@modelcontextprotocol/client";
import { callMcpTool, connectMcp, McpToolError } from "./mcp-client.ts";
import { configPath, loadConfig } from "../config.ts";
import { classifyExaError, noteExaIssue } from "./exa-issue.ts";
import type { ExaCategory, SearchOptions, SearchResult } from "./search.ts";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_TOOLS = "web_search_exa,web_fetch_exa,web_search_advanced_exa";
const CALL_TIMEOUT_MS = 60_000;

// ── Credential resolution ─────────────────────────────────────────────────────
// pi-reader.json is canonical; the environment is the fallback. Resolved lazily
// and cached, so rotating the key needs no restart.

let cachedApiKey: string | null | undefined;
let cachedBaseUrl: string | undefined;

function resolveApiKey(): string | null {
  if (cachedApiKey === undefined) {
    cachedApiKey = loadConfig()?.exa?.apiKey ?? (process.env.EXA_API_KEY || null);
  }
  return cachedApiKey;
}

function resolveBaseUrl(): string {
  if (cachedBaseUrl === undefined) {
    cachedBaseUrl = loadConfig()?.exa?.url ?? EXA_MCP_URL;
  }
  return cachedBaseUrl;
}

// After the setup wizard writes a new key, the cache must forget the old
// answer (including "no key") — resolution is lazy, so this takes effect on
// the next Exa call with no restart.
export function resetExaKeyCache(): void {
  cachedApiKey = undefined;
  cachedBaseUrl = undefined;
}

// Where the current key came from, for diagnostics and the wizard's intro
// screen. Returns null when nothing is configured.
export function exaKeySource(): string | null {
  if (loadConfig()?.exa?.apiKey) return configPath();
  if (process.env.EXA_API_KEY) return "environment (EXA_API_KEY)";
  return null;
}

function endpointUrl(key: string): string {
  return `${resolveBaseUrl()}?exaApiKey=${encodeURIComponent(key)}&tools=${encodeURIComponent(EXA_TOOLS)}`;
}

/** Scrub the API key from error text before it can reach the agent transcript.
 *  Internal seam, exported for its own tests. Short keys are skipped: they
 *  occur in ordinary text, so redaction would mangle the message. */
export function redactKey(text: string, key: string | null): string {
  return key && key.length > 4 ? text.split(key).join("[redacted]") : text;
}

// ── Public interface ─────────────────────────────────────────────────────────

export async function searchExaMcp(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const text = await callExaTool("web_search_exa", {
    query,
    numResults: options.numResults ?? 10,
  }, { signal: options.signal });
  return parseFormattedResults(text);
}

export async function searchExaAdvanced(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const start = options.recency ? recencyStartDate(options.recency) : undefined;
  const domains = (options.domains ?? []).map((d) => d.trim());
  const includeDomains = domains.filter((d) => !d.startsWith("-") && d.length > 0);
  const excludeDomains = domains
    .filter((d) => d.startsWith("-"))
    .map((d) => d.slice(1).trim())
    .filter((d) => d.length > 0);

  const text = await callExaTool("web_search_advanced_exa", {
    query,
    numResults: options.numResults ?? 10,
    ...(options.category ? { category: options.category } : {}),
    ...(includeDomains.length ? { includeDomains } : {}),
    ...(excludeDomains.length ? { excludeDomains } : {}),
    ...(start ? { startPublishedDate: start } : {}),
    enableHighlights: true,
    ...(options.includeContent ? { textMaxCharacters: 50_000 } : {}),
    ...(options.includeSummary ? { enableSummary: true } : {}),
  }, { signal: options.signal });

  return parseJsonResults(text);
}

export async function fetchExaMcp(
  urls: string[],
  maxCharacters?: number,
  signal?: AbortSignal,
): Promise<Array<{ url: string; title: string; content: string; error: string | null }>> {
  const text = await callExaTool("web_fetch_exa", {
    urls,
    ...(maxCharacters ? { maxCharacters } : {}),
  }, { signal });
  return parseCrawlResults(text, urls);
}

// ── MCP client (lazy singleton, keep-alive, one reconnect) ───────────────────

export interface CallExaOptions {
  /** Use this key instead of the resolved one (wizard validation). */
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

let clientPromise: Promise<Client> | null = null;

async function getExaClient(): Promise<Client> {
  if (!clientPromise) {
    const key = resolveApiKey();
    if (!key) {
      throw new Error(
        "No Exa API key found. Run /exa-setup to set one up, or set the EXA_API_KEY environment variable.",
      );
    }
    clientPromise = connectMcp(endpointUrl(key)).catch((err) => {
      clientPromise = null; // failed connect doesn't poison the cache
      throw err;
    });
  }
  return clientPromise;
}

async function resetExaClient(): Promise<void> {
  const stale = clientPromise;
  clientPromise = null;
  try {
    (await stale)?.close();
  } catch {
    // best-effort cleanup
  }
}

/** Call one Exa MCP tool. Wraps callExaToolRaw so no error message leaves this
 *  module carrying the key — SDK transport errors embed the keyed endpoint URL,
 *  and these messages land in the agent transcript via tool results. */
export async function callExaTool(
  tool: string,
  args: Record<string, unknown>,
  options: CallExaOptions = {},
): Promise<string> {
  const key = options.apiKey ?? resolveApiKey();
  try {
    return await callExaToolRaw(tool, args, options);
  } catch (err) {
    const cleaned = redactKey(err instanceof Error ? err.message : String(err), key);
    if (cleaned === (err instanceof Error ? err.message : String(err))) throw err;
    throw err instanceof McpToolError ? new McpToolError(cleaned) : new Error(cleaned);
  }
}

async function callExaToolRaw(
  tool: string,
  args: Record<string, unknown>,
  options: CallExaOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  if (options.apiKey !== undefined) {
    const client = await connectMcp(endpointUrl(options.apiKey));
    try {
      return await callMcpTool(client, tool, args, { signal: options.signal, timeoutMs });
    } finally {
      void client.close().catch(() => {});
    }
  }

  try {
    const client = await getExaClient();
    return await callMcpTool(client, tool, args, { signal: options.signal, timeoutMs });
  } catch (err) {
    if (err instanceof McpToolError) throw err; // server answered: reconnecting won't help
    if (options.signal?.aborted) throw err;
    // Connection-level failure: one fresh connection, then surface.
    await resetExaClient();
    const client = await getExaClient();
    return await callMcpTool(client, tool, args, { signal: options.signal, timeoutMs });
  }
}

// ── Issue noting (rate-limit / missing-key hints) ────────────────────────────
// Wrapped at the public boundary rather than inside callExaTool so one-shot
// validation clients (wizard, candidate keys) don't pollute session hints.

async function withIssueNoting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const issue = classifyExaError(err instanceof Error ? err.message : String(err));
    if (issue) noteExaIssue(issue);
    throw err;
  }
}

// ── Response parsing ─────────────────────────────────────────────────────────

// web_search_exa returns blocks like:
//   Title: X\nURL: https://...\nPublished: ...\nAuthor: ...\nHighlights:\n...
// separated by "---".
export function parseFormattedResults(text: string): SearchResult[] {
  const blocks = text.split(/(?=^Title: )/m);
  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const title = block.match(/^Title:\s*(.+)/m)?.[1]?.trim() ?? "";
    const url = block.match(/^URL:\s*(\S+)/m)?.[1]?.trim() ?? "";
    const publishedDate = block.match(/^Published:\s*(\S+)/m)?.[1] ?? undefined;
    const author = block.match(/^Author:\s*(.+)/m)?.[1]?.trim() ?? undefined;
    if (!title || !url) continue;
    let snippet = "";
    const hl = block.match(/^Highlights:\s*\n([\s\S]*?)(?=\n---|$)/m)?.[1]?.trim();
    if (hl) {
      snippet = hl.replace(/\s+/g, " ").slice(0, 500);
    } else {
      snippet = block.match(/^Text:\s*(.+)/m)?.[1]?.trim().slice(0, 500) ?? "";
    }
    results.push({ title, url, snippet, publishedDate, author });
  }
  if (results.length === 0) throw new Error("Exa MCP returned no parseable results");
  return results;
}

// web_search_advanced_exa returns the sanitized search JSON.
export function parseJsonResults(text: string): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // fall through to formatted parser for robustness
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const raw = obj.results;
    if (Array.isArray(raw)) {
      const results: SearchResult[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        if (typeof r.url !== "string" || !r.url) continue;
        const highlights = Array.isArray(r.highlights)
          ? (r.highlights as unknown[]).filter((h): h is string => typeof h === "string")
          : [];
        const snippet = highlights.length
          ? highlights.join(" ").replace(/\s+/g, " ").slice(0, 500)
          : typeof r.text === "string"
            ? r.text.replace(/\s+/g, " ").trim().slice(0, 500)
            : "";
        results.push({
          title: typeof r.title === "string" ? r.title : "",
          url: r.url,
          snippet,
          ...(typeof r.publishedDate === "string" ? { publishedDate: r.publishedDate } : {}),
          ...(typeof r.author === "string" && r.author ? { author: r.author } : {}),
          ...(typeof r.text === "string" && r.text ? { content: r.text } : {}),
        });
      }
      if (results.length === 0) throw new Error("Exa MCP returned no results");
      return results;
    }
  }
  return parseFormattedResults(text);
}

// web_fetch_exa returns "# Title\nURL: ...\n\ncontent" per URL, with error
// lines for failures.
export function parseCrawlResults(
  text: string,
  requested: string[],
): Array<{ url: string; title: string; content: string; error: string | null }> {
  const out: Array<{ url: string; title: string; content: string; error: string | null }> = [];
  const blocks = text.split(/(?=^# )/m).filter((b) => b.trim());

  for (const block of blocks) {
    const title = block.match(/^#\s*(.*)/m)?.[1]?.trim() ?? "";
    const url = block.match(/^URL:\s*(\S+)/m)?.[1]?.trim() ?? "";
    if (!url) continue;
    const content = block
      .replace(/^#\s.*\n/, "")
      .replace(/^URL:\s*\S+\s*\n?/, "")
      .replace(/^Error fetching \S+:.*$/gm, "")
      .trim();
    out.push({ url, title, content: content || "", error: null });
  }

  // Error lines: "Error fetching <url>: <tag>"
  for (const line of text.split("\n")) {
    const m = line.match(/^Error fetching (\S+):\s*(.+)$/);
    if (m) {
      const url = m[1]!;
      const err = m[2]!;
      const existing = out.find((o) => o.url === url);
      if (existing) existing.error = err;
      else out.push({ url, title: "", content: "", error: err });
    }
  }

  // Ensure requested order; mark missing as errors so callers can report them.
  const byUrl = new Map(out.map((o) => [o.url, o]));
  return requested.map((u) => byUrl.get(u) ?? { url: u, title: "", content: "", error: "no content returned" });
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function recencyStartDate(recency: "day" | "week" | "month" | "year"): string {
  const now = Date.now();
  const offsets: Record<typeof recency, number> = {
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  const days = offsets[recency];
  return new Date(now - days * 86400000).toISOString().slice(0, 10);
}

export function exaCategoryList(): ExaCategory[] {
  return [
    "company",
    "publication",
    "news",
    "personal site",
    "people",
    "pdf",
    "github",
    "financial report",
  ];
}
