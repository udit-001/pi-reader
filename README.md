# pi-reader

Web search and URL→Markdown for the [Pi coding agent](https://pi.dev). DuckDuckGo free, Exa for semantic search, Wikipedia/HN/Context7 for focused queries. Zero config.

## Install

```bash
pi install git:github.com/udit-001/pi-reader
```

## What you get

**`web_search`** — search the web. DuckDuckGo by default (free, no key). Exa for semantic search when you pass Exa params (`category`, `includeContent`, `domains`). Wikipedia for factual lookups, HN for community tech opinions, Context7 for library/framework docs.

```text
web_search({ query: "Stripe API create subscription Node.js example" })
web_search({ query: "category:company API testing tools", provider: "exa", includeContent: true })
web_search({ query: "React server components", provider: "context7" })
web_search({ query: "best Go HTTP router 2024", provider: "hn" })
```

| Param | Type | Notes |
|-------|------|-------|
| `query` | string | Describe the page you want, not keywords |
| `provider` | `"auto" \| "duckduckgo" \| "exa" \| "wikipedia" \| "hn" \| "context7"` | Default `auto`: DDG first, Exa fallback. Free providers are explicit-only. |
| `numResults` | 1–25 | Default 10 with category, 15 without |
| `recency` | `"day" \| "week" \| "month" \| "year"` | Filter by publish date |
| `domains` | string[] | `["github.com", "-reddit.com"]` |
| `category` | Exa only | `company`, `publication`, `news`, `personal site`, `people`, `pdf`, `github`, `financial report` |
| `includeContent` | boolean | Exa: full page text (up to 50k chars each) |
| `includeSummary` | boolean | Exa: AI summary per result |

**`web_fetch`** — URLs as clean Markdown, raw response bodies, or feed summaries. Add `prompt` to answer a question about the content, `topic` to extract only matching sections, and `mode: "raw"` to inspect the exact HTML/XML a server returned.

```text
web_fetch({ urls: "https://docs.example.com/guide" })
web_fetch({ urls: ["https://a.com", "https://b.com"], maxChars: 10000 })
web_fetch({ urls: "https://article.com", prompt: "Summarize the security implications" })
web_fetch({ urls: "https://large-doc.com/api", topic: "authentication" })
web_fetch({ urls: "https://openai.com/news/rss.xml" })        // channel title + recent posts
web_fetch({ urls: "https://example.com", mode: "raw" })       // exact body, status + content-type labeled
```

| Param | Type | Notes |
|-------|------|-------|
| `urls` | string \| string[] | One URL or many in parallel |
| `maxChars` | 500–100000 | Default 20000 per page |
| `prompt` | string | Answer this about the pages using the current Pi model |
| `topic` | string | Extract only sections matching this topic |
| `mode` | `"markdown" \| "raw"` | `raw` returns the exact response body, labeled with HTTP status and content type |
| `model` | string | Override the summarizing model (requires `prompt`) |

## How fetching works

The fetch chain tries local extraction first (Defuddle for HTML, Next.js RSC flight payloads for client-rendered pages, regex for edge cases, and a curl retry with a real Chrome profile for bot-walled pages), then free remote services (Jina Reader for JS-rendered pages, markdown.new for PDFs), then Exa MCP as last resort. Specialized handlers exist for GitHub, GitLab, Reddit, HackerNews, StackExchange, Wikipedia, arXiv, RSS/Atom feeds, and 8 package registries (npm, PyPI, crates.io, Go, Maven, Hex, Packagist, RubyGems) — these return structured content instead of scraped HTML.

Fetches are network-guarded: loopback, private-range, and cloud-metadata addresses are blocked — including across redirect hops — so pointing the agent at a hostile page can't bounce it at your internal network. Response bodies are capped at 5 MB.

Fetched pages are cached locally for 7 days. Search results are cached for 1 hour.

## Config

None required. DuckDuckGo and the free providers work immediately. Exa key resolves from `~/.pi/agent/pi-reader.json` (written by the wizard), then `mcp.json` (legacy), then `EXA_API_KEY` env var. No key means Exa returns a setup hint; DuckDuckGo keeps working.

## `/exa-setup` — the key wizard

When Exa needs a key, the tools surface a one-shot hint. The wizard validates, previews, and writes atomically. If a key exists in `mcp.json`, it offers to import and dedupe.

## License

MIT
