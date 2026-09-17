# pi-reader

Web search and URL→Markdown fetch for the [Pi coding agent](https://pi.dev). DuckDuckGo free, Exa for semantic search. Zero config.

## Install

```bash
pi install git:github.com/udit-001/pi-reader
```

## What you get

**`web_search`** — search the web. DuckDuckGo by default (free, no key). Exa for semantic search when you pass Exa params (`category`, `includeContent`, `domains`).

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

**`web_fetch`** — URLs as clean Markdown. Add `prompt` to answer a question about the content.

```text
web_fetch({ urls: "https://docs.example.com/guide" })
web_fetch({ urls: ["https://a.com", "https://b.com"], maxChars: 10000 })
web_fetch({ urls: "https://article.com", prompt: "Summarize the security implications" })
```

## Config

None required. DuckDuckGo works immediately. Exa key resolves from `~/.pi/agent/pi-reader.json` (written by the wizard), then `mcp.json` (legacy), then `EXA_API_KEY` env var. No key means Exa returns a setup hint; DuckDuckGo keeps working.

## `/exa-setup` — the key wizard

When Exa needs a key, the tools surface a one-shot hint. The wizard validates, previews, and writes atomically. If a key exists in `mcp.json`, it offers to import and dedupe.

## License

MIT
