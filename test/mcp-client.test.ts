// Tests for the shared MCP client glue's pure seam: resultText — CallToolResult
// → text payload, with tool-error and empty-content rejection. Connection and
// call timeouts need a live server and stay behind the module interface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resultText, McpToolError } from "../search/mcp-client.ts";

test("mcp: resultText joins text content blocks from an SDK callTool result", () => {
  assert.equal(
    resultText({ content: [{ type: "text", text: "Title: A" }, { type: "text", text: "URL: https://a" }] }),
    "Title: A\nURL: https://a",
  );
});

test("mcp: resultText throws McpToolError on isError with the server's message", () => {
  assert.throws(
    () =>
      resultText({
        content: [{ type: "text", text: "searchGitHub error (429): too many requests" }],
        isError: true,
      }),
    (err: unknown) => err instanceof McpToolError && /too many requests/.test((err as Error).message),
  );
});

test("mcp: resultText falls back to a generic message when isError carries no text", () => {
  assert.throws(() => resultText({ isError: true }), McpToolError, "MCP tool returned an error");
});

test("mcp: resultText throws on empty content", () => {
  assert.throws(() => resultText({ content: [] }), /empty content/);
  assert.throws(() => resultText({ content: [{ type: "text", text: "  " }] }), /empty content/);
});
