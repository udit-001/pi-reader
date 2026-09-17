# pi-web

Web search and URL→Markdown fetch for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Two providers, zero config.

## Install

```bash
pi install git:github.com/udit-001/pi-web
```

## What you get

**`web_search`** — search the web. DuckDuckGo by default (free, no key). Exa for semantic search when you pass Exa-specific params (`category`, `includeContent`, `domains`).

```text
web_search({ query: "Stripe API create subscription Node.js example" })
web_search({ query: "category:company API testing tools", provider: "exa", includeContent: true })
```

| Param | Type | Notes |
|-------|------|-------|
| `query` | string | Describe the page you want, not keywords |
| `provider` | `"auto" \| "duckduckgo" \| "exa"` | Default `auto`: DDG first, Exa fallback |
| `numResults` | 1–25 | Default 10 |
| `recency` | `"day" \| "week" \| "month" \| "year"` | Filter by publish date |
| `domains` | string[] | `["github.com", "-reddit.com"]` |
| `category` | Exa only | `company`, `publication`, `news`, `personal site`, `people`, `pdf`, `github`, `financial report` |
| `includeContent` | boolean | Exa: full page text (up to 50k chars) |
| `includeSummary` | boolean | Exa: AI summary per result |

**`web_fetch`** — URLs as clean Markdown. Optionally answer a prompt about the pages.

```text
web_fetch({ urls: "https://docs.example.com/guide" })
web_fetch({ urls: ["https://a.com", "https://b.com"], maxChars: 10000 })
web_fetch({ urls: "https://article.com", prompt: "Summarize the security implications" })
```

Fetches locally first (Defuddle for HTML, regex fallback). Blocked or dynamic pages fall through: Jina Reader (free, renders JS, bypasses Cloudflare) → markdown.new (free) → Exa MCP last. The `prompt` param runs extracted content through the current pi model to answer a question — full markdown always returned alongside.

## Config

None required. DuckDuckGo works immediately. Exa resolves its key lazily from:

1. `~/.pi/agent/pi-web.json` → `exa.apiKey` (written by the wizard)
2. `~/.pi/agent/mcp.json` → `mcpServers.exa.url` → `exaApiKey` (legacy, auto-imported)
3. `EXA_API_KEY` environment variable

No key means Exa calls return a setup hint. DuckDuckGo keeps working.

## `/exa-setup` — the key wizard

When Exa needs a key, `web_search`/`web_fetch` surface a one-shot hint pointing at `/exa-setup`. The wizard:

```text
Intro       enter opens the Exa dashboard (key creation), esc closes
Paste       paste or type the key — input is hidden
Validating  one cheap check against mcp.exa.ai (invalid keys rejected before metering)
Save        previews the config (key masked), then writes atomically
Done        what was written, where — no restart needed
```

If a key is found in `mcp.json`, the wizard offers to import it into pi-web's own config and clean up the duplicate. Keys resolve lazily — a saved key takes effect on the next Exa call.

## License

MIT
