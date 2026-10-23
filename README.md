# pi-reader

Web search and URL→Markdown for the [Pi coding agent](https://pi.dev). Two tools, zero keys: your agent can search the web and read any page the moment you install it.

## Install

```bash
pi install git:github.com/udit-001/pi-reader
```

## What your agent gets

- **Searches the web on day one** — DuckDuckGo answers with no key and no account, with recency windows (`day`/`week`/`month`/`year`) and pagination built in. Add `provider: "parallel"` for a second independent index when DDG is captcha-walled or thin, or `"wikipedia"`, `"hn"`, `"context7"` to query those directly.
- **Searches news, images, and video** — `provider: "news"` returns dated, outlet-attributed articles; `"images"` returns hotlinkable image URLs with dimensions, source domain, and a license filter on each row; `"videos"` returns watch URLs with duration, view count, and uploader. All three are explicit opt-ins, so auto-routing never picks them by accident.
- **Reads papers** — `provider: "papers"` returns citeable OpenAlex and Europe PMC records: authors, venue, DOI, topic, open-access links, and field-normalized impact. Retractions are excluded by default, a citation graph can be walked in either direction from any hit, and no key is needed.
- **Answers a question instead of listing pages** — `provider: "openai"` runs OpenAI's hosted web search on the ChatGPT/Codex login you already have and returns one cited answer. Opt-in, because it spends subscription quota; `searchModel` picks the model and defaults to the cheap tier.
- **Reaches Exa when you want semantics** — passing Exa params (category filters, full page content, domain restrictions) routes the search to Exa. `/search-setup` walks you through a key, and imports one already sitting in `mcp.json`.
- **Turns any URL into Markdown** — client-rendered and bot-walled pages included. Add `prompt` to get an answer about the page instead of its full text.
- **Returns code hosts as structure** — a GitHub or GitLab repo URL becomes a local checkout your agent walks with `read` and shell commands. Issues and PRs come back as the whole document: state, checks, review verdicts, files, commits, comments, private repos included when `gh` is authenticated. Also raw files, releases, RSS/Atom feeds, and 8 package registries (npm, PyPI, crates.io, Maven, Go, Hex, Packagist, RubyGems).
- **Brings answer sites ready to read** — arXiv papers as citation-ready summaries with full text on request, Reddit threads as post plus top comments, Stack Overflow questions with the accepted answer first, ORCID profiles as name, affiliations, and a deduped publication list with DOI links (the works list also as JSON), Wikipedia articles as plaintext, Wikidata entities as structured summaries.
- **Survives hostile pages** — the fetcher can't be bounced at your localhost, private network, or cloud-metadata endpoints, not even through redirects, and DNS answers are pinned against rebinding. Your Exa key is redacted from every error the tool emits, and fetched pages are cached locally.

Skipped on purpose: ddgs's books vertical (Anna's Archive). Beyond the shadow-library question, the backend returns no results at all (checked 2026-09).

```text
web_search({ query: "Stripe API create subscription Node.js example" })
web_search({ query: "what changed in Stripe billing", provider: "news", recency: "week" })
web_fetch({ urls: "github.com/vercel/next.js/pull/60000" })     # full PR in one call
web_fetch({ urls: "https://docs.example.com/api", prompt: "How do I paginate?" })
```

## Contributing

Architecture and rules live in [AGENTS.md](AGENTS.md): `npm install`, then `npm run typecheck && npm test`. Subsystem deep dives (fetch pipeline, search providers, GitHub rendering) are in [docs/](docs/) — read those before touching the seam.

## License

MIT
