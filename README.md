# pi-web

Lightweight web search and URL→Markdown fetch for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Two search providers, zero config:

- **DuckDuckGo** — keyword search, no API key, no account, no MCP. Always available.
- **Exa MCP** — semantic (vector) search via the remote MCP server at `mcp.exa.ai`, using the API key pi already has in `~/.pi/agent/mcp.json`. Supports category filters, domains, recency, full page text, and per-result summaries — no extra setup.

Fetch borrows the idea from [markitdown](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/summarize/SKILL.md): **everything becomes Markdown** so it can be inspected, quoted, and processed. Optionally answer a prompt about the pages using the current pi model.

## Install

```bash
pi install git:github.com/udit-001/pi-web
```

## What you get

### `web_search` — search the web

```text
web_search({ query: "Stripe API create subscription Node.js code example" })
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `query` | string | Required. Describe the page you want, not keywords (Exa is embedding-based) |
| `provider` | `"auto" \| "duckduckgo" \| "exa"` | Default `auto`: DuckDuckGo first, Exa MCP fallback |
| `numResults` | int 1–25 | Default 10 |
| `recency` | `"day" \| "week" \| "month" \| "year"` | Only results published within this window (Exa: date filter; DuckDuckGo: `df` param) |
| `domains` | string[] | Include/exclude — `["github.com", "-reddit.com"]` |
| `category` | Exa only | `company`, `publication`, `news`, `personal site`, `people`, `pdf`, `github`, `financial report` |
| `includeContent` | boolean | Exa: full page text per result (up to 50k chars) |
| `includeSummary` | boolean | Exa: AI summary per result |

Example:

```text
web_search({
  query: "category:company developer tools for API testing",
  provider: "exa",
  numResults: 10,
  includeContent: true,
})
```

### `web_fetch` — URLs as Markdown, optionally summarized

```text
web_fetch({ urls: "https://docs.example.com/guide" })
web_fetch({ urls: ["https://a.com", "https://b.com"], maxChars: 10000 })
web_fetch({ urls: "https://long-article.com", prompt: "Summarize the security implications and action items" })
```

- Fetches locally first: verbatim for markdown/text/JSON (respects `text/markdown` headers), [Defuddle](https://defuddle.md) extraction for HTML, regex converter as last resort. Fallback chain for blocked/dynamic pages: **Jina Reader** (free — renders JS, bypasses Cloudflare, parses PDFs) → **markdown.new** (free) → **Exa MCP** last, so quota is spent only on what nothing free could fetch.
- `prompt` runs the extracted content — as **untrusted data** — through the current pi model to answer a question about the page(s). Uses the markitdown summarize pattern: full converted markdown always returned alongside the summary; oversized input is truncated head+tail with an explicit marker so the model knows what it didn't see.

## Config

None required. The Exa MCP key is resolved lazily from, in order:

1. `~/.pi/agent/mcp.json` → `mcpServers.exa.url` → `exaApiKey` query param
2. `~/.pi/mcp.json`, then `.pi/mcp.json` (same shape)
3. `EXA_API_KEY` environment variable

No key means DuckDuckGo still works; Exa calls return a clear setup hint.

## `/exa-setup` — the guided key wizard

When Exa is rate-limited or no key is configured, `web_search`/`web_fetch` surface a one-shot hint pointing at `/exa-setup` (the wizard never auto-opens over a running session — it needs you at the keyboard). The command opens an inline wizard:

```text
Intro       enter opens the Exa dashboard (key creation), esc closes
Paste       paste or type the key — input is hidden
Validating  one cheap check against mcp.exa.ai (numResults 1;
            invalid keys are rejected before metering)
Save        previews the exact mcp.json entry (key masked), then writes
Done        what was written, where — no restart needed
```

Safety properties: the existing `mcpServers.exa` entry is upserted — `tools=` filter and sibling fields survive; other servers are untouched; a malformed `mcp.json` is never overwritten (you get the manual instructions instead); the key is never rendered (masked in previews, redacted from errors); headless mode prints the manual path. Keys resolve lazily, so a saved key takes effect on the next Exa call without restarting pi.

## How it's organized

Following the codebase-design deep-module playbook (small interfaces, real seams, depth behind them):

| File | Role |
|------|------|
| `index.ts` | Thin entry: registers the two tools, maps params → modules, formats output |
| `search.ts` | Deep module. The **SearchProvider seam**: provider resolution, `auto` fallback, answer synthesis. Callers interact with `webSearch()` only |
| `duckduckgo.ts` | Adapter at the seam: HTML scraping, regex parsing, entity decoding, redirect resolution |
| `exa-mcp.ts` | Adapter at the seam: JSON-RPC to the remote MCP, SSE/JSON response handling, three tool wrappers, result sanitizing |
| `fetch.ts` | Deep module. URL→Markdown seam: local fetch (sniffing, Defuddle, regex fallback) → free services (Jina, markdown.new) → Exa fallback, model summarization |
| `exa-issue.ts` | Tiny shared module: classifies Exa failures (`rate-limited` vs `missing-key`) so the adapter can note them and the entry point can surface a one-shot hint, without depending on each other |
| `exa-setup.ts` | The `/exa-setup` wizard: inline TUI (Intro → Paste → Validating → Save → Done), key validation, atomic mcp.json upsert (never clobber) |

Two adapters means the SearchProvider seam is real (per codebase-design "one adapter is a hypothetical seam; two is a real one"). The converter and all parsers are pure functions exported as internal seams, tested directly.

## Develop

```bash
npm install
npm run typecheck
npm test
```

## License

MIT