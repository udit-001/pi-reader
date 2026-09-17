// Exa MCP adapter — the second real adapter at the SearchProvider seam.
//
// Talks JSON-RPC to the remote MCP server (https://mcp.exa.ai/mcp) with the
// API key the user already has in ~/.pi/agent/mcp.json, so this works with
// zero extra setup. Exposes the three tools the remote server ships:
//   web_search_exa          — simple search, formatted text result
//   web_search_advanced_exa — filters/dates/domains, JSON result
//   web_fetch_exa           — URL → markdown content
//
// Response parsing is hidden behind two small functions: searchExaMcp and
// searchExaAdvanced. Everything else (JSON-RPC framing, SSE vs JSON response
// handling, sanitizing) is implementation detail.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExaCategory, SearchOptions, SearchResult } from "./search.ts";
import { classifyExaError, noteExaIssue } from "./exa-issue.ts";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_TOOLS = "web_search_exa,web_fetch_exa,web_search_advanced_exa";
const TIMEOUT_MS = 60_000;

// ── Credential / endpoint resolution ─────────────────────────────────────────
// Where the Exa MCP lives and what key to use comes from the same place pi
// gets it: ~/.pi/agent/mcp.json (or .pi/mcp.json), falling back to the
// EXA_API_KEY env var. Resolved lazily and cached, so rotating the key needs
// no restart.

let cachedApiKey: string | null | undefined;

export function mcpConfigPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".pi", "agent", "mcp.json"),
    join(home, ".pi", "mcp.json"),
    join(process.cwd(), ".pi", "mcp.json"),
  ];
}

function allExaApiKeys(): string[] {
  const found: string[] = [];
  for (const path of mcpConfigPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, { url?: string }> };
      const url = parsed?.mcpServers?.exa?.url;
      if (typeof url === "string") {
        const key = new URL(url).searchParams.get("exaApiKey");
        if (key) found.push(key);
      }
    } catch {
      // unreadable config — try the next path
    }
  }
  if (process.env.EXA_API_KEY) found.push(process.env.EXA_API_KEY);
  return found;
}

function resolveApiKey(): string | null {
  if (cachedApiKey !== undefined) return cachedApiKey;
  cachedApiKey = allExaApiKeys()[0] ?? null;
  return cachedApiKey;
}

// After the setup wizard writes a new key, the cache must forget the old
// answer (including "no key") — resolution is lazy, so this takes effect on
// the next Exa call with no restart.
export function resetExaKeyCache(): void {
  cachedApiKey = undefined;
}

// Where the current key came from, for diagnostics and the wizard's intro
// screen. Returns null when nothing is configured.
export function exaKeySource(): string | null {
  for (const path of mcpConfigPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, { url?: string }> };
      const url = parsed?.mcpServers?.exa?.url;
      if (typeof url === "string" && new URL(url).searchParams.get("exaApiKey")) return path;
    } catch {
      // unreadable config — try the next path
    }
  }
  if (process.env.EXA_API_KEY) return "environment (EXA_API_KEY)";
  return null;
}

function endpointUrl(): string {
  const key = resolveApiKey();
  if (!key) {
    throw new Error(
      "No Exa MCP API key found. Add the exa server to ~/.pi/agent/mcp.json (url https://mcp.exa.ai/mcp?exaApiKey=<key>&tools=web_search_exa,web_fetch_exa,web_search_advanced_exa) or set EXA_API_KEY.",
    );
  }
  return `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}&tools=${encodeURIComponent(EXA_TOOLS)}`;
}

// ── Public interface ─────────────────────────────────────────────────────────

export async function searchExaMcp(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const text = await mcpCall("web_search_exa", {
    query,
    numResults: options.numResults ?? 10,
  }, options.signal);
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

  const text = await mcpCall("web_search_advanced_exa", {
    query,
    numResults: options.numResults ?? 10,
    ...(options.category ? { category: options.category } : {}),
    ...(includeDomains.length ? { includeDomains } : {}),
    ...(excludeDomains.length ? { excludeDomains } : {}),
    ...(start ? { startPublishedDate: start } : {}),
    enableHighlights: true,
    ...(options.includeContent ? { textMaxCharacters: 50_000 } : {}),
    ...(options.includeSummary ? { enableSummary: true } : {}),
  }, options.signal);

  return parseJsonResults(text);
}

export async function fetchExaMcp(
  urls: string[],
  maxCharacters?: number,
  signal?: AbortSignal,
): Promise<Array<{ url: string; title: string; content: string; error: string | null }>> {
  const text = await mcpCall("web_fetch_exa", {
    urls,
    ...(maxCharacters ? { maxCharacters } : {}),
  }, signal);
  return parseCrawlResults(text, urls);
}

// ── JSON-RPC internals ───────────────────────────────────────────────────────

interface McpContentPart {
  type?: string;
  text?: string;
}

interface McpCallResult {
  result?: {
    content?: McpContentPart[];
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await mcpCallUnclassified(tool, args, signal);
  } catch (err) {
    // Record the failure kind so the session can hint at /exa-setup once,
    // even when callers auto-fallback to another provider and swallow this.
    const issue = classifyExaError(err instanceof Error ? err.message : String(err));
    if (issue) noteExaIssue(issue);
    throw err;
  }
}

async function mcpCallUnclassified(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const url = endpointUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.any(
      signal ? [AbortSignal.timeout(TIMEOUT_MS), signal] : [AbortSignal.timeout(TIMEOUT_MS)],
    ),
  });
  if (!res.ok) throw new Error(`Exa MCP error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.text();
  return extractResultText(body);
}

// Shared with exa-setup.ts, whose key validation parses the same envelopes.
export function extractResultText(body: string): string {
  // Streamable-HTTP may answer with SSE (data: lines) or plain JSON.
  let parsed: McpCallResult | null = null;

  if (body.includes("data:")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const candidate = JSON.parse(payload) as McpCallResult;
        if (candidate?.result || candidate?.error) {
          parsed = candidate;
          break;
        }
      } catch {
        // keep scanning
      }
    }
  }

  if (!parsed) {
    try {
      parsed = JSON.parse(body) as McpCallResult;
    } catch {
      throw new Error("Exa MCP returned an unparseable response");
    }
  }

  if (parsed.error) {
    throw new Error(`Exa MCP error ${parsed.error.code ?? ""}: ${parsed.error.message ?? "unknown"}`.trim());
  }
  if (parsed.result?.isError) {
    const msg = parsed.result.content
      ?.find((c) => c.type === "text" && typeof c.text === "string")
      ?.text;
    throw new Error(msg?.trim() || "Exa MCP returned an error");
  }

  const text = parsed.result?.content
    ?.find((c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0)
    ?.text;
  if (!text) throw new Error("Exa MCP returned empty content");
  return text;
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