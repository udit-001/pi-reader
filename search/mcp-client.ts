// Generic MCP client glue — the shared seam under every remote-MCP provider.
//
// Wraps @modelcontextprotocol/client, which owns the protocol (initialize
// handshake, session headers, SSE framing). This module adds only what the
// SDK leaves to callers, so adapters don't fork it:
//   connectMcp  — Client + StreamableHTTP transport, connect bounded by a timeout
//   callMcpTool — one tools/call, call+signal timeouts composed
//   resultText  — CallToolResult → text; throws McpToolError on isError/empty
//
// Policy lives with the adapters, never here: credentials and endpoint
// composition (Exa's keyed URL), keep-alive singletons and retry (Exa),
// stateless per-call connections (grep).

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const PI_WEB_VERSION = "0.2.0";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

/** Thrown when the server answered with a tool error — reconnecting cannot help. */
export class McpToolError extends Error {}

/** Minimal shape of the SDK's CallToolResult — enough to extract text. */
export interface ToolResultLike {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
}

/** Connect to a streamable-HTTP MCP server, bounded by a connect timeout. */
export async function connectMcp(
  url: string | URL,
  opts: { connectTimeoutMs?: number } = {},
): Promise<Client> {
  const client = new Client({ name: "pi-reader", version: PI_WEB_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(
        // Origin only: keyed endpoints (Exa) must not leak the query string into errors.
        () => reject(new Error(`MCP connection to ${new URL(url).origin} timed out`)),
        opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
  return client;
}

export interface CallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Call one tool and return its text payload (resultText semantics). */
export async function callMcpTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
  opts: CallToolOptions = {},
): Promise<string> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS);
  const result = await client.callTool(
    { name: tool, arguments: args },
    { signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout },
  );
  return resultText(result);
}

/** Turn an SDK callTool result into its text payload; throw on tool errors. */
export function resultText(result: ToolResultLike): string {
  if (result.isError) {
    const msg = result.content
      ?.find((c) => c.type === "text" && typeof c.text === "string")
      ?.text;
    throw new McpToolError(
      typeof msg === "string" && msg.trim() ? msg.trim() : "MCP tool returned an error",
    );
  }
  const text = result.content
    ?.filter((c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0)
    .map((c) => c.text as string)
    .join("\n");
  if (!text || !text.trim()) throw new McpToolError("MCP tool returned empty content");
  return text;
}
