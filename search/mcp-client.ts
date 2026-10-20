// Generic MCP client glue: the SDK owns the protocol, this adds only the timeout
// composition and text extraction every adapter needs, so none of them forks it.
// Policy stays with the adapters — credentials, endpoint composition, keep-alive
// and retry.

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

/** Connect to a streamable-HTTP MCP server, bounded by a connect timeout.
 *  `authToken` rides the Authorization header on every request — for servers
 *  whose keys must not appear in the endpoint URL (they would leak into
 *  transport error messages). */
export async function connectMcp(
  url: string | URL,
  opts: { connectTimeoutMs?: number; authToken?: string } = {},
): Promise<Client> {
  const client = new Client({ name: "pi-reader", version: PI_WEB_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(opts.authToken
      ? { requestInit: { headers: { Authorization: `Bearer ${opts.authToken}` } } }
      : {}),
  });
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
