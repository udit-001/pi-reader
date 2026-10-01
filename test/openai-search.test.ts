// Tests for the Codex web-search parse seams. The fixtures mirror the real
// Codex Responses stream: `output_item.done` carries each item, and
// `response.completed` arrives with an EMPTY output array — so the parser must
// collect items rather than trust the completed payload.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInstructions,
  buildWebSearchTool,
  cleanSourceUrl,
  extractAccountId,
  extractAnswer,
  extractSearchResults,
  isCodexJwt,
  normalizeDomainFilters,
  parseOpenAIResponse,
  pickSearchModel,
} from "../search/openai.ts";
import { redactSecret } from "../search/redact.ts";

// A minimal but faithful slice of the real stream.
const SSE = [
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","queries":["node latest"],"sources":[{"type":"url","url":"https://nodejs.org/en/download"},{"type":"url","url":"https://nodejs.org/en/about"}]}}}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","annotations":[{"type":"url_citation","start_index":0,"end_index":20,"title":"Node.js — Download","url":"https://nodejs.org/en/download?utm_source=openai"}],"text":"The latest stable version is v24.21.0."}]}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
  '',
].join("\n");

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.signature`;
}

// ── parseOpenAIResponse ─────────────────────────────────────────────────────

test("openai: parses the SSE stream by collecting output_item.done items", () => {
  const parsed = parseOpenAIResponse(SSE);
  assert.equal(parsed.output.length, 2);
  assert.equal(parsed.webSearchCallSeen, true);
});

test("openai: an empty response.completed output does not discard the streamed items", () => {
  // The real Codex endpoint sends response.completed with output: []. If the
  // parser preferred it, every search would parse as empty.
  const parsed = parseOpenAIResponse(SSE);
  assert.equal((parsed.output[0] as { type: string }).type, "web_search_call");
  assert.equal((parsed.output[1] as { type: string }).type, "message");
});

test("openai: a non-empty response.completed output wins over streamed items", () => {
  const body = [
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"streamed"}]}}',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"output":[{"type":"web_search_call"},{"type":"message","content":[{"type":"output_text","text":"completed"}]}]}}',
  ].join("\n");
  const parsed = parseOpenAIResponse(body);
  assert.equal(parsed.output.length, 2);
  assert.equal(extractAnswer(parsed.output), "completed");
});

test("openai: parses a plain JSON body (non-stream)", () => {
  const parsed = parseOpenAIResponse(
    JSON.stringify({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "hi" }] }] }),
  );
  assert.equal(parsed.webSearchCallSeen, true);
  assert.equal(extractAnswer(parsed.output), "hi");
});

test("openai: throws on a body with no parseable output", () => {
  assert.throws(() => parseOpenAIResponse('data: {"type":"response.completed","response":{"output":[]}}\n'), /no parseable response output/);
});

// ── extractAnswer / extractSearchResults ────────────────────────────────────

test("openai: extractAnswer concatenates message text", () => {
  assert.equal(extractAnswer(parseOpenAIResponse(SSE).output), "The latest stable version is v24.21.0.");
});

test("openai: citations come first, utm_source is stripped, sources dedupe against them", () => {
  const results = extractSearchResults(parseOpenAIResponse(SSE).output);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.url, "https://nodejs.org/en/download");
  assert.equal(results[0]!.title, "Node.js — Download");
  assert.ok(results[0]!.snippet.includes("v24.21.0"));
  // The web_search_call source for the same URL is deduped; /about is new.
  assert.equal(results[1]!.url, "https://nodejs.org/en/about");
  assert.equal(results[1]!.title, "https://nodejs.org/en/about");
});

test("openai: extractSearchResults honors numResults", () => {
  const results = extractSearchResults(parseOpenAIResponse(SSE).output, 1);
  assert.equal(results.length, 1);
});

test("openai: cleanSourceUrl strips only the openai utm tag", () => {
  assert.equal(cleanSourceUrl("https://x.example.com/p?utm_source=openai&a=1"), "https://x.example.com/p?a=1");
  assert.equal(cleanSourceUrl("https://x.example.com/p?utm_source=other"), "https://x.example.com/p?utm_source=other");
});

// ── model selection ─────────────────────────────────────────────────────────

test("openai: pickSearchModel prefers luna, then terra, and excludes pro/ultra", () => {
  const models = [
    { id: "gpt-6-sol" },
    { id: "gpt-5.6-terra" },
    { id: "gpt-5.6-luna" },
    { id: "gpt-9-ultra" },
    { id: "gpt-9-pro" },
  ];
  assert.equal(pickSearchModel(models)?.id, "gpt-5.6-luna");
  assert.equal(pickSearchModel(models.filter((m) => !m.id.includes("luna")))?.id, "gpt-5.6-terra");
});

test("openai: pickSearchModel sorts versions numerically", () => {
  const models = [{ id: "gpt-5.9" }, { id: "gpt-5.10" }];
  assert.equal(pickSearchModel(models)?.id, "gpt-5.10");
});

test("openai: pickSearchModel returns undefined for an empty list", () => {
  assert.equal(pickSearchModel([]), undefined);
});

// ── JWT helpers ─────────────────────────────────────────────────────────────

test("openai: a token carrying the OpenAI auth claim is a Codex token", () => {
  const token = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
  assert.equal(isCodexJwt(token), true);
  assert.equal(extractAccountId(token), "acct_123");
});

test("openai: a plain token is not a Codex token and yields no account id", () => {
  const token = fakeJwt({ sub: "user_1" });
  assert.equal(isCodexJwt(token), false);
  assert.equal(extractAccountId(token), undefined);
  assert.equal(isCodexJwt("not-a-jwt"), false);
});

// ── request building ────────────────────────────────────────────────────────

test("openai: domains split into allowed and blocked filters", () => {
  assert.deepEqual(normalizeDomainFilters(["github.com", "-reddit.com"]), {
    allowed_domains: ["github.com"],
    blocked_domains: ["reddit.com"],
  });
  assert.equal(normalizeDomainFilters([]), null);
  assert.equal(normalizeDomainFilters(undefined), null);
});

test("openai: the web_search tool carries domain filters only when given", () => {
  assert.deepEqual(buildWebSearchTool({}), { type: "web_search" });
  assert.deepEqual(buildWebSearchTool({ domains: ["arxiv.org"] }), {
    type: "web_search",
    filters: { allowed_domains: ["arxiv.org"] },
  });
});

test("openai: instructions carry recency and result count", () => {
  const instructions = buildInstructions({ recency: "week", numResults: 5 });
  assert.ok(instructions.includes("past week"));
  assert.ok(instructions.includes("5 distinct sources"));
});

// ── redaction ───────────────────────────────────────────────────────────────

test("redact: redactSecret scrubs the token from error text", () => {
  const key = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
  const cleaned = redactSecret(`request with ${key} failed`, key);
  assert.ok(!cleaned.includes(key));
  assert.ok(cleaned.includes("[redacted]"));
  assert.equal(redactSecret("nothing to redact", key), "nothing to redact");
  assert.equal(redactSecret("text with ab", "ab"), "text with ab");
});
