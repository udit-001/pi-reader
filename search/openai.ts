// openai.ts — Codex web search: OpenAI's hosted `web_search` tool on the
// ChatGPT/Codex subscription Pi already holds. No API key, no separate signup.
//
// The seam mirrors exa-mcp.ts: searchOpenAI(query, options, ctx) ->
// { answer, results }. Everything behind it is implementation: credential
// resolution through Pi's model registry, endpoint selection, request
// building, SSE parsing, citation extraction, and key redaction.
//
// This is the first provider whose `answer` is model-authored prose rather
// than a rendering of the rows — OpenAI's search is model-mediated: the model
// decides the queries, the server runs them, the model writes a grounded
// answer with url_citation annotations. search.ts returns that answer verbatim
// and falls back to buildAnswer only when the model returned citations with no
// text.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.ts";
import { redactSecret } from "./redact.ts";
import type { SearchOptions, SearchResult } from "./search.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const SEARCH_TIMEOUT_MS = 60_000;

/** Pi providers that can carry an OpenAI web-search credential, in priority
 *  order: the ChatGPT/Codex subscription first, then a plain OpenAI API key. */
const SEARCH_PROVIDERS = ["openai-codex", "openai"] as const;

/** Thrown when no ChatGPT/Codex credential resolves. The message is the
 *  recovery path, and the entry passes it through verbatim (like PaperError)
 *  instead of rewriting it into a generic hint. */
export class OpenAISearchUnavailableError extends Error {}

export interface OpenAISearchResult {
  answer: string;
  results: SearchResult[];
}

interface OpenAIAuth {
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  responsesUrl: string;
  useCodexEndpoint: boolean;
}

// ── Model selection ─────────────────────────────────────────────────────────
// Prefer the cheapest tier that still orchestrates well. "luna" is the cheap
// tier on this account; "terra" is the mid tier; then any versioned gpt id.
// Price tiers ("pro"/"ultra") are excluded. The numeric-aware sort keeps e.g.
// gpt-5.10 ahead of gpt-5.9.

const EXCLUDED_MODEL_SEGMENTS = new Set(["pro", "ultra"]);
const MODEL_PREFERENCE: ReadonlyArray<(id: string) => boolean> = [
  (id) => id.includes("luna"),
  (id) => id.includes("terra"),
  (id) => /^gpt-\d/.test(id),
];

/** Pure; exported for tests. */
export function pickSearchModel<T extends { id: string }>(models: readonly T[]): T | undefined {
  const candidates = models
    .filter((m) => !m.id.split("-").some((s) => EXCLUDED_MODEL_SEGMENTS.has(s)))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const prefers of MODEL_PREFERENCE) {
    const hit = candidates.find((m) => prefers(m.id));
    if (hit) return hit;
  }
  return candidates[0];
}

// ── JWT helpers ─────────────────────────────────────────────────────────────
// Codex credentials are ChatGPT JWTs. The account id lives under the OpenAI
// auth claim; a token carrying that claim is a Codex token, not an API key.

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pure; exported for tests. */
export function isCodexJwt(token: string): boolean {
  return !!decodeJwtPayload(token)?.["https://api.openai.com/auth"];
}

/** Pure; exported for tests. */
export function extractAccountId(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  const id = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

// ── Credential resolution ───────────────────────────────────────────────────

function toRequestHeaders(headers: Record<string, string | null> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== null) out[name] = value;
  }
  return out;
}

async function resolveAuth(ctx?: ExtensionContext): Promise<OpenAIAuth | undefined> {
  if (!ctx?.modelRegistry) return undefined;
  const config = loadConfig()?.openai;
  const pinnedModel = config?.searchModel?.trim() || undefined;
  const configuredUrl = config?.responsesUrl?.trim() || undefined;

  let models: ReturnType<ExtensionContext["modelRegistry"]["getAll"]>;
  try {
    models = ctx.modelRegistry.getAll();
  } catch {
    return undefined;
  }

  for (const provider of SEARCH_PROVIDERS) {
    const preferred = pickSearchModel(models.filter((m) => m.provider === provider));
    if (!preferred) continue;
    let resolved: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
    try {
      resolved = await ctx.modelRegistry.getApiKeyAndHeaders(preferred);
    } catch {
      continue;
    }
    if (!resolved.ok || !resolved.apiKey) continue;
    const useCodexEndpoint = provider === "openai-codex" || isCodexJwt(resolved.apiKey);
    const responsesUrl = configuredUrl ?? (useCodexEndpoint ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL);
    return {
      apiKey: resolved.apiKey,
      model: pinnedModel ?? preferred.id,
      headers: toRequestHeaders(resolved.headers),
      responsesUrl,
      useCodexEndpoint,
    };
  }
  return undefined;
}

// ── Request building ────────────────────────────────────────────────────────

interface NormalizedDomains {
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/** Pure; exported for tests. `+`/bare domains are allowed, `-` prefixed are
 *  blocked. Returns null when nothing usable was given. */
export function normalizeDomainFilters(domains: string[] | undefined): NormalizedDomains | null {
  if (!domains?.length) return null;
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const raw of domains) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const isBlocked = trimmed.startsWith("-");
    const domain = (isBlocked ? trimmed.slice(1) : trimmed).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!domain) continue;
    const target = isBlocked ? blocked : allowed;
    if (!target.includes(domain)) target.push(domain);
  }
  return allowed.length || blocked.length
    ? {
      ...(allowed.length ? { allowed_domains: allowed.slice(0, 100) } : {}),
      ...(blocked.length ? { blocked_domains: blocked.slice(0, 100) } : {}),
    }
    : null;
}

/** Pure; exported for tests. */
export function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
  const filters = normalizeDomainFilters(options.domains);
  return { type: "web_search", ...(filters ? { filters } : {}) };
}

/** Pure; exported for tests. */
export function buildInstructions(options: SearchOptions): string {
  const lines = [
    "Search the web and return a concise answer grounded only in the web results.",
    "Include clickable source citations in the response text when possible.",
  ];
  if (options.recency) {
    const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
    lines.push(`Prefer sources from the ${labels[options.recency]}.`);
  }
  if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
    lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
  }
  return lines.join(" ");
}

function buildRequestBody(query: string, options: SearchOptions, auth: OpenAIAuth): Record<string, unknown> {
  return {
    model: auth.model,
    instructions: buildInstructions(options),
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [buildWebSearchTool(options)],
    include: ["web_search_call.action.sources"],
    store: false,
    stream: true,
    tool_choice: "required",
    parallel_tool_calls: true,
  };
}

function buildHeaders(auth: OpenAIAuth): Record<string, string> {
  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
  };
  if (auth.useCodexEndpoint) {
    const accountId = extractAccountId(auth.apiKey);
    if (accountId) headers["chatgpt-account-id"] = accountId;
  }
  return headers;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ── Response parsing ────────────────────────────────────────────────────────
// Pure seams, exported for tests. The stream carries `output_item.done` for
// each item; `response.completed` can arrive with an EMPTY output array (the
// Codex endpoint does this), so completed output is used only when non-empty.

function isWebSearchCall(item: unknown): boolean {
  return !!item && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call";
}

function isMessage(item: unknown): item is { type: "message"; content: Array<Record<string, unknown>> } {
  return (
    !!item
    && typeof item === "object"
    && (item as { type?: unknown }).type === "message"
    && Array.isArray((item as { content?: unknown }).content)
  );
}

export interface ParsedOpenAIResponse {
  output: unknown[];
  webSearchCallSeen: boolean;
}

/** Pure; exported for tests. Accepts a streamed SSE body or a plain JSON body. */
export function parseOpenAIResponse(text: string): ParsedOpenAIResponse {
  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`OpenAI returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const payload = Array.isArray(parsed) ? { output: parsed } : (parsed as Record<string, unknown>);
    const output = Array.isArray(payload.output) ? payload.output : [];
    return { output, webSearchCallSeen: output.some(isWebSearchCall) };
  }

  const items: unknown[] = [];
  let completed: unknown[] | null = null;
  let webSearchCallSeen = false;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type.startsWith("response.web_search_call")) webSearchCallSeen = true;
    if (type === "response.output_item.done" && event.item) {
      items.push(event.item);
      webSearchCallSeen ||= isWebSearchCall(event.item);
    }
    if ((type === "response.completed" || type === "response.done") && event.response && typeof event.response === "object") {
      const output = (event.response as { output?: unknown }).output;
      if (Array.isArray(output) && output.length > 0) completed = output;
    }
  }

  const output = completed ?? items;
  webSearchCallSeen ||= output.some(isWebSearchCall);
  if (output.length === 0) throw new Error("OpenAI web search returned no parseable response output");
  return { output, webSearchCallSeen };
}

/** Pure; exported for tests. OpenAI appends `utm_source=openai` to cited URLs. */
export function cleanSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/, "");
  }
}

function snippetAround(text: string, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || !text) return "";
  const snippet = text
    .slice(Math.max(0, start - 100), Math.min(text.length, end + 100))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(results: SearchResult[], seen: Set<string>, url: unknown, title: unknown, snippet = ""): void {
  if (typeof url !== "string" || !url.trim()) return;
  const cleanUrl = cleanSourceUrl(url);
  if (seen.has(cleanUrl)) return;
  seen.add(cleanUrl);
  results.push({
    title: typeof title === "string" && title.trim() ? title : cleanUrl,
    url: cleanUrl,
    snippet,
  });
}

/** Pure; exported for tests. Citations first (they carry titles and context),
 *  then any extra URLs the search call saw. */
export function extractSearchResults(output: unknown[], numResults?: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const item of output) {
    if (!isMessage(item)) continue;
    for (const part of item.content) {
      const text = typeof part.text === "string" ? part.text : "";
      const annotations = part.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
        const a = annotation as Record<string, unknown>;
        addResult(results, seen, a.url, a.title, snippetAround(text, a.start_index, a.end_index));
      }
    }
  }

  for (const item of output) {
    if (!isWebSearchCall(item)) continue;
    const call = item as { action?: { sources?: unknown }; sources?: unknown; results?: unknown };
    for (const group of [call.action?.sources, call.sources, call.results]) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        if (!source || typeof source !== "object") continue;
        const s = source as Record<string, unknown>;
        addResult(results, seen, s.url ?? s.source_website_url, s.title ?? s.caption);
      }
    }
  }

  return typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0
    ? results.slice(0, Math.min(Math.floor(numResults), 20))
    : results;
}

/** Pure; exported for tests. */
export function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isMessage(item)) continue;
    for (const part of item.content) {
      if (typeof part.text === "string" && part.text.trim()) parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

// ── Public interface ────────────────────────────────────────────────────────

async function runSearch(query: string, options: SearchOptions, auth: OpenAIAuth): Promise<OpenAISearchResult> {
  const response = await fetch(auth.responsesUrl, {
    method: "POST",
    headers: buildHeaders(auth),
    body: JSON.stringify(buildRequestBody(query, options, auth)),
    signal: withTimeout(options.signal),
  });

  if (!response.ok) {
    const body = redactSecret(await response.text().catch(() => ""), auth.apiKey);
    throw new Error(`OpenAI web search failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  }

  const parsed = parseOpenAIResponse(await response.text());
  if (!parsed.webSearchCallSeen) {
    throw new Error("OpenAI web search returned no web_search_call — the selected model may not support the hosted tool.");
  }
  const answer = extractAnswer(parsed.output);
  const results = extractSearchResults(parsed.output, options.numResults);
  if (!answer && results.length === 0) throw new Error("OpenAI web search returned no answer or sources.");
  return { answer, results };
}

export async function searchOpenAI(
  query: string,
  options: SearchOptions = {},
  ctx?: ExtensionContext,
): Promise<OpenAISearchResult> {
  const auth = await resolveAuth(ctx);
  if (!auth) {
    throw new OpenAISearchUnavailableError(
      "OpenAI search needs a ChatGPT/Codex subscription. Run /login to sign in, " +
        "or use provider: 'duckduckgo' (free) or 'exa'.",
    );
  }
  try {
    return await runSearch(query, options, auth);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redacted = redactSecret(message, auth.apiKey);
    if (redacted === message) throw err;
    const next = err instanceof Error ? new Error(redacted) : new Error(redacted);
    next.name = err instanceof Error ? err.name : "Error";
    throw next;
  }
}
