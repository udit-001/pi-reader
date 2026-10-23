// Parallel MCP adapter — the third real adapter at the SearchProvider seam.
//
// Policy layered over the shared MCP client glue (mcp-client.ts): a lazy
// singleton client over StreamableHTTP, kept alive for the process lifetime,
// with one reconnect-and-retry on connection failure. Tool-level errors
// (McpToolError) are never retried — a rate limit won't heal by reconnecting.
//
// Key difference from Exa: the anonymous free tier is the default product.
// No key = works (fast mode, per-session rate limits). An optional key
// (PARALLEL_API_KEY or /search-setup parallel) raises the rate limits and unlocks
// connection-level overrides; it rides the Authorization header, never the
// URL, so it cannot leak into transport error messages. Because a missing key
// is a valid configuration, the only issue worth noting is rate-limiting.
//
// One stable session_id per process (generated lazily, reused for every
// call): the server keys free-tier rate limiting to it, so a fresh id per
// call would defeat the shared budget; a stable id keeps one agent session
// inside one bucket, which is what the docs prescribe.

import type { Client } from "@modelcontextprotocol/client";
import { callMcpTool, connectMcp, McpToolError } from "./mcp-client.ts";
import { configPath, loadConfig } from "../config.ts";
import { redactSecret } from "./redact.ts";
import { randomUUID } from "node:crypto";
import type { SearchOptions, SearchResult } from "./search.ts";

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const CALL_TIMEOUT_MS = 60_000;

// ── Credential resolution ─────────────────────────────────────────────────────
// pi-reader.json is canonical; the environment is the fallback. Both are
// optional — resolution returns null and the client connects anonymously.
// Resolved lazily and cached, so a newly saved key needs no restart.

let cachedApiKey: string | null | undefined;
let cachedBaseUrl: string | undefined;

function resolveApiKey(): string | null {
  if (cachedApiKey === undefined) {
    cachedApiKey = loadConfig()?.parallel?.apiKey ?? process.env.PARALLEL_API_KEY ?? null;
  }
  return cachedApiKey;
}

function resolveBaseUrl(): string {
  if (cachedBaseUrl === undefined) {
    cachedBaseUrl = loadConfig()?.parallel?.url ?? PARALLEL_MCP_URL;
  }
  return cachedBaseUrl;
}

// After the setup wizard writes a new key, the cache must forget the old
// answer (including "no key") — resolution is lazy, so this takes effect on
// the next Parallel call with no restart.
export function resetParallelKeyCache(): void {
  cachedApiKey = undefined;
  cachedBaseUrl = undefined;
}

// Where the current key came from, for diagnostics and the wizard's intro
// screen. Returns null when running anonymous (the default).
export function parallelKeySource(): string | null {
  if (loadConfig()?.parallel?.apiKey) return configPath();
  if (process.env.PARALLEL_API_KEY) return "environment (PARALLEL_API_KEY)";
  return null;
}

// ── Session identity (free-tier rate-limit bucket) ────────────────────────────

let sessionId: string | null = null;

function resolveSessionId(): string {
  sessionId ??= randomUUID();
  return sessionId;
}

// ── Issue noting (rate-limit hints) ───────────────────────────────────────────
// Only rate-limiting is an issue: anonymous is a supported configuration, so
// there is no missing-key state to report (unlike Exa). Noted at the public
// boundary so one-shot validation clients don't pollute session hints.

export type ParallelIssue = "rate-limited";

let pendingIssue: ParallelIssue | null = null;

export function noteParallelIssue(issue: ParallelIssue): void {
  pendingIssue = issue;
}

export function consumeParallelIssue(): ParallelIssue | null {
  const issue = pendingIssue;
  pendingIssue = null;
  return issue;
}

export function classifyParallelError(message: string): ParallelIssue | null {
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(message)) return "rate-limited";
  return null;
}

async function withIssueNoting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const issue = classifyParallelError(err instanceof Error ? err.message : String(err));
    if (issue) noteParallelIssue(issue);
    throw err;
  }
}

// ── MCP client (lazy singleton, keep-alive, one reconnect) ───────────────────

let clientPromise: Promise<Client> | null = null;
/** Key the live client was connected with — a wizard-saved key must replace
 *  the connection, not shadow it. */
let clientKey: string | null = null;

async function getParallelClient(key: string | null): Promise<Client> {
  if (!clientPromise || clientKey !== key) {
    if (clientPromise) {
      const stale = clientPromise;
      clientPromise = null;
      void stale.then((c) => c.close()).catch(() => {});
    }
    clientKey = key;
    clientPromise = connectMcp(resolveBaseUrl(), key ? { authToken: key } : {}).catch((err) => {
      clientPromise = null; // failed connect doesn't poison the cache
      clientKey = null;
      throw err;
    });
  }
  return clientPromise;
}

async function resetParallelClient(): Promise<void> {
  const stale = clientPromise;
  clientPromise = null;
  clientKey = null;
  try {
    (await stale)?.close();
  } catch {
    // best-effort cleanup
  }
}

export interface CallParallelOptions {
  /** Use this key instead of the resolved one (wizard validation). */
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Call one Parallel MCP tool. Wraps callParallelToolRaw so no error message
 *  leaves this module carrying the key — SDK transport errors are the one
 *  place a credential could surface, and these messages reach the agent
 *  transcript via tool results. */
export async function callParallelTool(
  tool: string,
  args: Record<string, unknown>,
  options: CallParallelOptions = {},
): Promise<string> {
  const key = options.apiKey ?? resolveApiKey();
  try {
    return await callParallelToolRaw(tool, args, options);
  } catch (err) {
    const original = err instanceof Error ? err.message : String(err);
    const cleaned = redactSecret(original, key);
    if (cleaned === original) throw err;
    throw err instanceof McpToolError ? new McpToolError(cleaned) : new Error(cleaned);
  }
}

async function callParallelToolRaw(
  tool: string,
  args: Record<string, unknown>,
  options: CallParallelOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  if (options.apiKey !== undefined) {
    // One-shot validation client — never touches the keep-alive singleton.
    const client = await connectMcp(resolveBaseUrl(), { authToken: options.apiKey });
    try {
      return await callMcpTool(client, tool, args, { signal: options.signal, timeoutMs });
    } finally {
      void client.close().catch(() => {});
    }
  }

  const key = resolveApiKey();
  try {
    const client = await getParallelClient(key);
    return await callMcpTool(client, tool, args, { signal: options.signal, timeoutMs });
  } catch (err) {
    if (err instanceof McpToolError) throw err; // server answered: reconnecting won't help
    if (options.signal?.aborted) throw err;
    // Connection-level failure: one fresh connection, then surface.
    await resetParallelClient();
    const client = await getParallelClient(key);
    return await callMcpTool(client, tool, args, { signal: options.signal, timeoutMs });
  }
}

// ── Public interface ─────────────────────────────────────────────────────────

export async function searchParallelMcp(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const text = await withIssueNoting(() =>
    callParallelTool("web_search", {
      // Both required by the server; the query is the objective verbatim —
      // pi-reader has no richer intent to send, and inventing one would
      // paraphrase the agent's own words away.
      objective: query,
      search_queries: [query],
      session_id: resolveSessionId(),
    }, { signal: options.signal }),
  );
  const results = parseParallelResults(text);
  const limit = options.numResults ?? 10;
  return results.slice(0, limit);
}

// ── Response parsing ─────────────────────────────────────────────────────────
// web_search returns sanitized JSON:
//   { "search_id": "search_…", "results": [
//       { "url": "…", "title": "…", "publish_date": "…" | null,
//         "excerpts": ["…"] } ] }
// Excerpts are the server's ~25k-char budget already trimmed; joining them is
// the snippet.

export function parseParallelResults(text: string): SearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Parallel MCP returned a non-JSON response");
  }
  const results = (data as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    throw new Error("Parallel MCP response has no results array");
  }
  const out: SearchResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;
    const excerpts = Array.isArray(r.excerpts)
      ? (r.excerpts as unknown[]).filter((e): e is string => typeof e === "string")
      : [];
    const snippet = excerpts.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
    out.push({
      title: typeof r.title === "string" ? r.title : "",
      url: r.url,
      snippet,
      ...(typeof r.publish_date === "string" && r.publish_date
        ? { publishedDate: r.publish_date }
        : {}),
    });
  }
  if (out.length === 0) throw new Error("Parallel MCP returned no parseable results");
  return out;
}
