// pi-reader — web search (DuckDuckGo + Exa MCP) and URL→Markdown
// fetch for the Pi coding agent. Zero config: reads the Exa MCP key from the
// same ~/.pi/agent/mcp.json pi uses; DuckDuckGo needs no key at all.
//
// Tools:
//   web_search — search the web. provider: "auto" (DuckDuckGo → Exa MCP
//     fallback), "duckduckgo", or "exa". Exa supports category filters,
//     domains, recency, and full content/summary extraction via the
//     web_search_advanced_exa tool on the remote MCP.
//   web_fetch — fetch URL(s) as clean Markdown. Structured handlers render
//     known sites directly (GitHub/GitLab repos: metadata+README, releases,
//     issues/PRs, raw files; package registries; Wikipedia, HN, Reddit,
//     Stack Exchange, arXiv); everything else falls through the free remote
//     fallback chain (Jina, markdown.new) to Exa MCP. Optional: answer a
//     prompt about the pages using the current pi model.
//
// Shape: thin entry. The depth lives in search.ts (provider seam + result
// normalization) and fetch.ts (content-type sniffing + conversion).

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { consumeExaIssue } from "./search/exa-issue.ts";
import { exaCategoryList } from "./search/exa-mcp.ts";
import { detectMcpDuplicate, openExaSetup } from "./search/exa-setup.ts";
import { configPath, loadConfig, saveConfig } from "./config.ts";
import { webSearch, type SearchProviderName } from "./search/search.ts";
import { fetchContent, summarizeContent, type FetchResult } from "./fetch/fetch.ts";

// ── Schemas ──────────────────────────────────────────────────────────────────

const providerSchema = Type.Optional(
  Type.Union(
    [
      Type.Literal("auto"),
      Type.Literal("duckduckgo"),
      Type.Literal("exa"),
      Type.Literal("wikipedia"),
      Type.Literal("hn"),
      Type.Literal("context7"),
    ],
    {
      description:
        "Search provider. 'auto' tries DDG then Exa. " +
        "'wikipedia' for factual queries, 'hn' to keyword-search HN discussions, 'context7' for library docs.",
    },
  ),
);

const recencySchema = Type.Optional(
  Type.Union(
    [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
    { description: "Only results published within this window" },
  ),
);

const domainSchema = Type.Optional(
  Type.Array(Type.String(), {
    description: "Restrict to domains (prefix with - to exclude, e.g. ['github.com', '-reddit.com'])",
  }),
);

const webSearchParams = Type.Object({
  query: Type.String({
    description: "Example: 'category:company AI infrastructure startups San Francisco'.",
  }),
  provider: providerSchema,
  numResults: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 25,
    description: "Results to return. Default: 10 with category, 15 without.",
  })),
  recency: recencySchema,
  domains: domainSchema,
  category: Type.Optional(Type.Union(
    exaCategoryList().map((c) => Type.Literal(c)) as [ReturnType<typeof Type.Literal<string>>, ...ReturnType<typeof Type.Literal<string>>[]],
    {
      description:
        "Filter by content type. Use 'company' for company/funding data, " +
        "'people' for LinkedIn/professional profiles, 'news' for recent events, " +
        "'publication' for papers/articles, 'github' for code/repos.",
    },
  )),
  includeContent: Type.Optional(Type.Boolean({
    description: "Exa: include full page text for each result (up to 50k chars each)",
  })),
  includeSummary: Type.Optional(Type.Boolean({
    description: "Exa: generate an AI summary for each result",
  })),
});

const webFetchParams = Type.Object({
  urls: Type.Union(
    [
      Type.String({ description: "URL to fetch as Markdown" }),
      Type.Array(Type.String(), { description: "Multiple URLs to fetch in parallel" }),
    ],
    { description: "URL(s) to fetch. Pass a plain string, not a JSON-encoded array." },
  ),
  maxChars: Type.Optional(Type.Integer({
    minimum: 500,
    maximum: 100_000,
    description: "Max characters per page (default: 3000)",
  })),
  mode: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("raw")], {
    description:
      "Response format. 'markdown' (default) extracts readable content. " +
      "'raw' returns the exact response body — HTML/XML/JSON with a status and content-type label — " +
      "for metadata inspection, structured data in pages, or debugging extraction.",
  })),
  prompt: Type.Optional(Type.String({
    description: "If set, answer this prompt about the page(s) using the current pi model",
  })),
  topic: Type.Optional(Type.String({
    description: "Extract sections matching this topic instead of returning full content",
  })),
  model: Type.Optional(Type.String({
    description: "Override for the summarizing model (provider/model-id). Requires prompt.",
  })),
});

type WebSearchParams = Static<typeof webSearchParams>;
type WebFetchParams = Static<typeof webFetchParams>;

// ── Extension entry ──────────────────────────────────────────────────────────

// The adapter notes rate-limit/missing-key issues as they happen, even when
// callers auto-fallback and swallow the error. This surfaces them once, with
// the recovery path — the wizard never auto-opens over a running session.
function notifyExaIssueOnce(ctx: ExtensionContext): void {
  const issue = consumeExaIssue();
  if (!issue) return;
  if (issue === "rate-limited") {
    ctx.ui.notify("Exa is rate limited. /exa-setup to replace the key — DuckDuckGo still works.", "warning");
  } else {
    ctx.ui.notify("No Exa API key configured. /exa-setup to add one — DuckDuckGo still works.", "warning");
  }
}

export default function piWeb(pi: ExtensionAPI): void {
  pi.registerCommand("exa-setup", {
    description: "Set up or replace the Exa API key (guided wizard)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      openExaSetup(ctx);
    },
  });

  // Duplication hygiene: an mcp.json exa entry with directTools puts exa's
  // raw tools next to web_search/web_fetch in every session. The detailed
  // explanation fires once per user (persisted flag in our config); while the
  // condition persists, later sessions get one brief reminder at start. Both
  // self-heal the moment the entry is removed.
  pi.on("session_start", (_event, ctx) => {
    if (!detectMcpDuplicate()) return;
    const config = loadConfig() ?? { version: 1 };
    if (config.hints?.mcpDuplicate) {
      ctx.ui.notify("Exa configured in both mcp.json and pi-reader — /exa-setup to dedupe", "info");
      return;
    }
    ctx.ui.notify(
      "Exa is configured in mcp.json, and pi-reader's web_search/web_fetch already cover it. " +
        "Run /exa-setup to import the key and remove the duplicate.",
      "warning",
    );
    saveConfig(configPath(), {
      ...config,
      version: 1,
      hints: { ...config.hints, mcpDuplicate: new Date().toISOString() },
    });
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. DuckDuckGo by default (free, no key); Exa for semantic search " +
      "when you pass Exa params (category, domains, includeContent). 'wikipedia' for factual " +
      "'what is X' queries; 'hn' for HN discussions (current listings come from web_fetch on " +
      "news.ycombinator.com); 'context7' for library docs. Describe the page you want to " +
      "find, not the fact you want to know.",
    promptSnippet: "Use for web research questions.",
    parameters: webSearchParams,
    async execute(
      _callId: string,
      params: WebSearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      try {
        const provider = (params.provider ?? "auto") as "auto" | SearchProviderName;
        // Smart default: category present → precise (10), broad discovery → 15
        const numResults = params.numResults ?? (params.category ? 10 : 15);
        const response = await webSearch(params.query, {
          provider,
          numResults,
          recency: params.recency,
          domains: params.domains,
          category: params.category as "company" | "publication" | "news" | "personal site" | "people" | "pdf" | "github" | "financial report" | undefined,
          includeContent: params.includeContent,
          includeSummary: params.includeSummary,
          signal,
        });

        const lines = [`Provider: ${response.provider}`, "", response.answer, "", "Results:"];
        for (let i = 0; i < response.results.length; i++) {
          const r = response.results[i]!;
          const hasContent = typeof r.content === "string" && r.content;
          lines.push(`${i + 1}. ${r.title || "(untitled)"}`);
          lines.push(`   ${r.url}`);
          if (r.publishedDate) lines.push(`   Published: ${r.publishedDate}`);
          if (hasContent) lines.push(`   ${r.content!.replace(/\s+/g, " ").trim().slice(0, 400)}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            provider: response.provider,
            resultCount: response.results.length,
            results: response.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.snippet.slice(0, 500),
              ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
              ...(typeof r.content === "string" && r.content ? { contentLength: r.content.length } : {}),
            })),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Actionable errors: tell the agent what to do next
        let error: string;
        if (/DuckDuckGo/i.test(message)) {
          error = "Search failed. Try provider: 'exa' or rephrase with a descriptive query.";
        } else if (/rate.?limit/i.test(message)) {
          error = "Search failed. Run /exa-setup to replace the key, or wait and retry.";
        } else if (/no.*key|not.*configured|missing/i.test(message)) {
          error = "Search failed. Run /exa-setup to configure an Exa API key.";
        } else if (/no.*results|parseable/i.test(message)) {
          error = "No results found. Try a longer, more descriptive query. Describe the page you want to find.";
        } else if (/timeout|ECONNREFUSED|fetch.*fail/i.test(message)) {
          error = "Search failed. Check your network connection and retry.";
        } else {
          error = `Search failed (${message}). Try a different query or provider.`;
        }
        // Never expose raw internal errors — agent only sees actionable guidance
        return {
          content: [{ type: "text", text: error }],
          details: { error },
        };
      } finally {
        notifyExaIssueOnce(ctx);
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Fetch as Markdown",
    description:
      "Fetch URL(s) as clean Markdown. Known sites come back structured in one call: " +
      "GitHub (repo and /tree/... URLs return a local checkout — read or bash the path; " +
      "releases, issues/PRs, and blob URLs return their content), GitLab, package registries " +
      "(npm, PyPI, crates.io, …), Wikipedia, Reddit, Stack Exchange, arXiv, HN (item pages " +
      "and listings), and RSS/Atom feeds (.xml, .rss, .atom, /feed). " +
      "mode:'raw' returns the exact response body with a status and content-type label — " +
      "for metadata inspection, structured data in pages, or debugging extraction. " +
      "topic extracts just the matching sections of long pages. " +
      "prompt answers a question about the fetched content using the current model. " +
      "Accepts one URL string or an array of URLs.",
    promptSnippet:
      "Use to read full page content from known URLs (docs, articles, issues); " +
      "GitHub repos return a local checkout in one call.",
    parameters: webFetchParams,
    async execute(
      _callId: string,
      params: WebFetchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      try {
        const urls = Array.isArray(params.urls) ? params.urls : [params.urls];
        const results = await fetchContent(urls, {
          maxChars: params.maxChars,
          signal,
          topic: params.topic,
          mode: params.mode,
        });

        // Summarize the pages if a prompt was given.
        if (params.prompt) {
          interface Fetchable extends FetchResult {
            content: string;
          }
          const ok = results.filter((r): r is Fetchable => !r.error && r.content.length > 0);
          if (ok.length === 0) {
            return {
              content: [{ type: "text", text: "No fetchable content to summarize." }],
              details: { results },
            };
          }
          const summary = await summarizeContent(
            { prompt: params.prompt, sources: ok, model: params.model },
            ctx,
            signal,
          );
          const summaryText = [`## Summary (${summary.model})`, "", summary.text, "", "---", ""]
            .concat(results.map((r) => r.error
              ? `### ${r.url}\n\nError: ${r.error}`
              : `### ${r.url}\n\n${r.content}`))
            .join("\n");
          return {
            content: [{ type: "text", text: summaryText }],
            details: { summarized: true, model: summary.model, results },
          };
        }

        const text = results
          .map((r) => r.error
            ? `### ${r.url}\n\nError: ${r.error}`
            : `### ${r.title || r.url}\n\n${r.content}`)
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: text || "No content." }],
          details: { results },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let hint = "";
        if (/Failed to parse URL/i.test(message)) {
          hint = "Check the URL format — must start with http:// or https://.";
        } else if (/fetch.*fail|ECONNREFUSED|ENOTFOUND/i.test(message)) {
          hint = "The URL may be unreachable. Verify it's correct and try again.";
        } else if (/HTTP\s+(4[0-9]{2}|5[0-9]{2})/i.test(message)) {
          hint = "The server returned an error. The URL may require authentication or be blocked.";
        } else if (/Unsupported content type/i.test(message)) {
          hint = "This content type is not supported. The URL may still work via remote fallback.";
        } else if (/timeout/i.test(message)) {
          hint = "The request timed out. Try again or use a different URL.";
        } else {
          hint = `The fetch failed (${message}). Check the URL and try again.`;
        }
        // Never expose raw internal errors — agent only sees actionable guidance
        return {
          content: [{ type: "text", text: `web_fetch failed: ${hint}` }],
          details: { error: hint },
        };
      } finally {
        notifyExaIssueOnce(ctx);
      }
    },
  });
}