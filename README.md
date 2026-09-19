# pi-reader

Web search and URL→Markdown for the [Pi coding agent](https://pi.dev). Two tools, zero config, no API key required.

## Install

```bash
pi install git:github.com/udit-001/pi-reader
```

## What your agent gets

- **Web search with no setup** — DuckDuckGo works immediately and shrugs off bot walls, with recency windows (`day`/`week`/`month`/`year`) and pagination built in. Wikipedia, Hacker News, and Context7 (library docs) are one `provider` word away.
- **News and image search** — `provider: "news"` returns dated, outlet-attributed articles; `provider: "images"` returns hotlinkable image URLs — dimensions, source domain, and a license filter ride in each result, so one hit is enough to embed, download, or vision-check. Both are explicit opt-ins; auto-routing never picks them.
- **Semantic search when you want it** — pass Exa params (category filters, full page content, domain restrictions) and search routes to Exa. `/exa-setup` adds a key in a guided wizard — and imports one you already have in `mcp.json`.
- **Any URL becomes clean Markdown** — client-rendered pages and bot-walled pages included. Pass `prompt` to get an answer about the content instead of the raw text.
- **Known sites come back structured** — a GitHub repo URL returns a local checkout your agent explores with `read` and shell commands; issues and PRs return the full document (state, checks, review verdicts, files, commits, comments — private repos too). Plus releases, RSS/Atom feeds, and 8 package registries (npm, PyPI, crates.io, …).
- **Safe by default** — hostile pages can't bounce the fetcher at your localhost, private network, or cloud-metadata endpoints — not even through redirects, and DNS answers are pinned against rebinding. Your Exa key is redacted from every error that leaves the tool. Fetched pages are cached locally, so repeat reads are instant.

```text
web_search({ query: "Stripe API create subscription Node.js example" })
web_search({ query: "what changed in Stripe billing", provider: "news", recency: "week" })
web_fetch({ urls: "github.com/vercel/next.js/pull/60000" })     # full PR in one call
web_fetch({ urls: "https://docs.example.com/api", prompt: "How do I paginate?" })
```

## Contributing

Architecture and rules: [AGENTS.md](AGENTS.md) — `npm install`, then `npm run typecheck && npm test`. Subsystem deep dives (fetch pipeline, search providers, GitHub rendering) live in [docs/](docs/); open them before touching those seams.

## License

MIT
