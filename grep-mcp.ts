// grep.app MCP adapter — real-world code search across public GitHub repos.
//
// Third adapter at the shared MCP client glue (mcp-client.ts). Policy:
// stateless — one connect + one tools/call per search (grep searches are
// infrequent; the keep-alive singleton isn't worth it) — and no credentials:
// the service is free. Explicit-only provider, never in the auto-fallback
// chain: grep.app indexes a curated subset of GitHub, so auto-routing it
// would silently narrow broad research queries.
//
// Queries are literal code patterns (or regex with useRegexp) — keywords find
// nothing here. The tool description and the query param description both say
// so; the seam enforces nothing.

import { callMcpTool, connectMcp, McpToolError } from "./mcp-client.ts";
import type { SearchResult } from "./search.ts";

export const GREP_MCP_URL = "https://mcp.grep.app";

export interface GrepSearchInput {
  /** Literal code pattern ("useState(") or regex with useRegexp. */
  query: string;
  useRegexp?: boolean;
  matchCase?: boolean;
  matchWholeWords?: boolean;
  /** "owner/repo" or an org prefix like "vercel/". */
  repo?: string;
  /** Path filter, e.g. "src/" or "*.test.ts". */
  path?: string;
  /** e.g. ["TypeScript", "TSX"]. */
  language?: string[];
}

export async function searchGrepCode(
  input: GrepSearchInput & { signal?: AbortSignal },
): Promise<SearchResult[]> {
  const { signal, query, ...optional } = input;
  const args: Record<string, unknown> = { query };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && !(key === "language" && !(value as string[]).length)) {
      args[key] = value;
    }
  }

  let text: string;
  try {
    const client = await connectMcp(GREP_MCP_URL);
    try {
      text = await callMcpTool(client, "searchGitHub", args, { signal });
    } finally {
      void client.close().catch(() => {});
    }
  } catch (err) {
    if (err instanceof McpToolError) {
      throw new Error(
        /429|rate|quota/i.test(err.message)
          ? "grep.app is rate limited. Retry shortly, or use provider 'exa' with category 'github'."
          : `grep.app rejected the search: ${err.message}`,
      );
    }
    throw new Error(
      `grep.app is unreachable (${err instanceof Error ? err.message : String(err)}). ` +
        "Use provider 'exa' with category 'github' as a fallback.",
    );
  }
  return normalizeGrepResults(text);
}

// ── Parse seam (tested in test/grep-mcp.test.ts) ─────────────────────────────
// searchGitHub returns one block per match:
//   Repository: owner/repo
//   Path: src/.../file.ts
//   URL: https://github.com/owner/repo/blob/.../file.ts
//   License: MIT
//
//   Snippets:
//   --- Snippet 1 (Line 54) ---
//   ...code...

const SNIPPET_CONTENT_CAP = 2000;

export function normalizeGrepResults(text: string): SearchResult[] {
  const blocks = text.split(/(?=^Repository: )/m);
  const results: SearchResult[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const repo = block.match(/^Repository:\s*(\S+)/m)?.[1]?.trim();
    const path = block.match(/^Path:\s*(.+)/m)?.[1]?.trim() ?? "";
    const url = block.match(/^URL:\s*(\S+)/m)?.[1]?.trim();
    if (!repo || !url) continue;
    const snippets = block.split(/^Snippets:\s*$/m)[1]?.trim() ?? "";
    results.push({
      title: path ? `${repo} · ${path}` : repo,
      url,
      snippet: condenseSnippet(snippets),
      ...(snippets ? { content: snippets.slice(0, SNIPPET_CONTENT_CAP) } : {}),
    });
  }
  // Zero matches is a normal answer for literal-pattern search — an empty
  // result set, not a failure. Only a response with Repository blocks but no
  // URL (or an unparseable format change) can't produce results here; callers
  // see [] and the agent adjusts the pattern.
  return results;
}

/** First snippet, marker dropped, whitespace collapsed — list-view sized. */
function condenseSnippet(snippetsBlock: string): string {
  const first = snippetsBlock
    .split(/^--- Snippet \d+[^\n]*---$/m)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return (first ?? "").replace(/\s+/g, " ").slice(0, 300);
}
