# pi-reader

Web search and URL→Markdown for the [Pi coding agent](https://pi.dev). Two tools, zero config, no API key required.

## Install

```bash
pi install git:github.com/udit-001/pi-reader
```

## What your agent gets

- **Web search with no setup** — DuckDuckGo works immediately and shrugs off bot walls, with recency windows (`day`/`week`/`month`/`year`) and pagination built in. Wikipedia, Hacker News, and Context7 (library docs) are one `provider` word away.
- **News, image, and video search** — `provider: "news"` returns dated, outlet-attributed articles; `provider: "images"` returns hotlinkable image URLs — dimensions, source domain, and a license filter ride in each result, so one hit is enough to embed, download, or vision-check; `provider: "videos"` returns watch URLs with duration, view count, and uploader — pick a video and hand the URL to a watcher. All are explicit opt-ins; auto-routing never picks them.
- **Deliberately excluded** — ddgs's books vertical (Anna's Archive): shadow-library positioning aside, the backend returns no results at all (verified 2026-09).
- **Scholarly search built in** — `provider: "papers"` returns citeable records from OpenAlex and Europe PMC (PubMed, PMC copies, preprints): authors, venue, DOI, topic, open-access links, and field-normalized impact on every row. Retracted work is excluded by default; walk a citation graph from any hit (who cites it, what it cites), sort by citations, date, or impact, and filter with OpenAlex's full expression grammar — no key required.
- **Semantic search when you want it** — pass Exa params (category filters, full page content, domain restrictions) and search routes to Exa. `/exa-setup` adds a key in a guided wizard — and imports one you already have in `mcp.json`.
- **Grounded answers from your Codex subscription** — `provider: "openai"` runs OpenAI's hosted web search on the ChatGPT/Codex login you already have: one cited, synthesized answer instead of a page list, no API key. Explicit opt-in (it spends subscription quota); `searchModel` picks the model, defaulting to the cheap tier.
- **Any URL becomes clean Markdown** — client-rendered pages and bot-walled pages included. Pass `prompt` to get an answer about the content instead of the raw text.
- **Code hosts come back structured** — a GitHub or GitLab repo URL returns a local checkout your agent explores with `read` and shell commands; issues and PRs return the full document (state, checks, review verdicts, files, commits, comments — private repos too); raw files come back verbatim. Plus releases, RSS/Atom feeds, and 8 package registries (npm, PyPI, crates.io, …).
- **Answer sites arrive ready to read** — arXiv papers as citation-ready summaries (full text on request), Reddit threads as post + top comments, Stack Overflow questions with the accepted answer first, ORCID profiles as name, affiliations, and a deduped publication list with DOI links — the works list also arrives as JSON when the agent wants to process it, Wikipedia articles and Wikidata entities as clean plaintext.
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
