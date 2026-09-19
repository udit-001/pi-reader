# pi-reader

Web search and URL→Markdown for the [Pi coding agent](https://pi.dev). Two tools, zero config, no API key required.

## Install

```bash
pi install git:github.com/udit-001/pi-reader
```

## What your agent gets

- **Web search with no setup** — DuckDuckGo works immediately and shrugs off bot walls; Wikipedia, Hacker News, and Context7 (library docs) are one `provider` word away.
- **Semantic search when you want it** — pass Exa params (category filters, full page content, domain restrictions) and search routes to Exa. `/exa-setup` adds a key in a guided wizard — and imports one you already have in `mcp.json`.
- **Any URL becomes clean Markdown** — client-rendered pages and bot-walled pages included. Pass `prompt` to get an answer about the content instead of the raw text.
- **Known sites come back structured** — a GitHub repo URL returns a local checkout your agent explores with `read` and shell commands; issues and PRs return the full document (state, checks, review verdicts, files, commits, comments — private repos too). Plus releases, RSS/Atom feeds, and 8 package registries (npm, PyPI, crates.io, …).
- **Safe by default** — hostile pages can't bounce the fetcher at your localhost, private network, or cloud-metadata endpoints. Fetched pages are cached locally, so repeat reads are instant.

```text
web_search({ query: "Stripe API create subscription Node.js example" })
web_fetch({ urls: "github.com/vercel/next.js/pull/60000" })     # full PR in one call
web_fetch({ urls: "https://docs.example.com/api", prompt: "How do I paginate?" })
```

## Contributing

Architecture and rules: [AGENTS.md](AGENTS.md) — `npm install`, then `npm run typecheck && npm test`. Subsystem deep dives (fetch pipeline, search providers, GitHub rendering) live in [docs/](docs/); open them before touching those seams.

## License

MIT
