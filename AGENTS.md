# AGENTS.md — pi-reader

Pi extension: `web_search` (DuckDuckGo, Exa, Parallel, papers, news/images/videos, Codex), `web_fetch` (URL→Markdown), and `web_crawl` (bounded site sweep). Zero config on the default path.

## Gate

`npm run typecheck && npm test` — both green before every commit. No build step: TypeScript runs through Node's `--test` loader.

Papers wire-drift (real API calls, metered, skipped by default): `PIWEB_LIVE_SMOKE=1 node --test test/papers-live-smoke.test.ts`. Run it whenever a papers request shape, projection, or error mapping changes.

## The seam model

The entry (`index.ts`) stays thin: registers the two tools, maps params, formats output, consumes issue hints once per call. Depth lives in the deep modules:

| Module | Seam |
|--------|------|
| `search/search.ts` | Provider seam: routing, fallback, answer synthesis |
| `search/ddgs-uv.ts`, `duckduckgo.ts`, `news.ts`, `images.ts`, `videos.ts` | ddgs seam and its verticals: shared argv plan (`buildDdgsArgs`), private tmp dir, warm-up, recency map, direct v.js client |
| `search/papers.ts`, `paper-backend.ts`, `europepmc.ts` | Papers vertical: backend dispatch (`index`), shared record, Europe PMC backend |
| `search/openai.ts` | Codex web search: hosted `web_search` on the Pi ChatGPT/Codex subscription, explicit-only, quota-costed |
| `search/mcp-client.ts`, `exa-mcp.ts`, `parallel-mcp.ts` | MCP glue and the two remote providers: transport, key resolution, retry, parse seam; policy stays in the adapters |
| `search/key-setup.ts`, `exa-setup.ts`, `parallel-setup.ts`, `openalex-setup.ts` | Wizard skeleton (paste→validate→save→done, spinner, redaction, headless path, reopen guard) and its three instances |
| `search/exa-issue.ts`, `redact.ts` | One-shot issue hint per tool call; `redactSecret` keeps keys out of the transcript |
| `fetch/fetch.ts`, `curl-fetch.ts` | URL→Markdown: local extraction → free services → Exa; the bot-wall curl rescue |
| `fetch/crawl.ts` | Sweep: seed + budgets → `CrawlResult`; capped-vs-complete, excerpts, backend selection (uv driver vs JS fallback) |
| `fetch/crawl-uv.ts` | trafilatura driver via uv: sitemap-first → BFS, embedded script, guarded fetches, parse seam |
| `fetch/handlers/`, `topic.ts` | Per-site structured rendering (GitHub, registries, HN, feeds, …); `matchTopic` section extraction |
| `fetch/github-clone.ts`, `github-issue-pr.ts` | Local checkouts (`ensureClone`, `renderRepoView`, `resolveTreePath`); issue/PR documents, gh-first with REST fallback |
| `cache/cache.ts` | Fetch cache on disk: lookup/store/prune, sqlite index in `cachedb.ts` |
| `config.ts` | All config file I/O: `~/.pi/agent/pi-reader.json`, atomic |
| `render.ts` | Transcript view: `searchView()` is pure; theme and TUI stay in the callbacks |

**Two adapters = real seam.** One adapter is hypothetical; two is the proof. A third provider satisfies `SearchProvider` in `search/search.ts` and registers in the provider map. `autoChain()` picks the `[primary, failure-fallback]` pair by intent params — a pure function, tested on its own.

**Fetch chain:** local (Defuddle, regex, one curl retry) → Jina Reader → markdown.new → Exa MCP. Free tiers first.

## Deep dives

This file carries seams and rules; `docs/` carries mechanism. Open the doc whose subject you are about to change.

- [`docs/fetch-pipeline.md`](docs/fetch-pipeline.md) — the fetch chain, its guard, caps, timeouts, cache.
- [`docs/search-providers.md`](docs/search-providers.md) — routing, the ddgs/uvx path, every provider, keys, config, wizards.
- [`docs/github.md`](docs/github.md) — repo checkouts and issue/PR rendering.
- [`docs/papers.md`](docs/papers.md) — the papers vertical: backends, record shape, citation walks, metering.

## Conventions

- **Imports:** `.ts` extensions everywhere (`import { x } from "./foo.ts"`). NodeNext resolution.
- **Schemas:** Typebox only. The schema descriptions in `index.ts` are the single param reference — a param's behavior and its description change in the same commit. The papers filter grammar is composed from `EXPRESSION_PARAM_DESCRIPTION` in `search/papers.ts`, beside the merge rule it describes, so the vocabulary the description names is the list the tests assert.
- **Errors in band:** `execute()` catches → `{ content: [{ type: "text", text: <recovery path> }] }`. The agent gets the next action, never a throw.
- **Exa issues:** adapters call `noteExaIssue()`; the entry calls `consumeExaIssue()` once in `finally`, so the hint fires once per tool call.
- **Tests:** `node:test` + `node:assert/strict`, one `test()` per behavior, fixtures inline. Test the parse seam, not the HTTP layer.
- **Config:** `config.ts` owns all file I/O. Writes atomic (tmp + rename); reads forgiving (missing or malformed → null).
- **Docs:** one owner per meaning. A fact stated in two files is a bug in the second one.

## Adding a feature

1. **Search provider** — adapter satisfying `SearchProvider` in `search/search.ts`, registered in the provider map; extend `autoChain()` only for Exa-equivalent intent params. Done when `test/routing.test.ts` pins both the route and the fallback.
2. **Fetch fallback** — insert into the chain in `fetch/fetch.ts` before Exa; it must be free or Exa-backed. Done when a fixture URL resolves through the new tier and the tiers below it still pass.
3. **Tool param** — Typebox schema in `index.ts`, pass-through to the deep module, routing test when it moves `autoChain()`. Done when the schema description, the behavior, and the test agree.
4. **MCP tool** — wrapper on `search/mcp-client.ts` exposed through its adapter (`searchExaAdvanced()` or a new export); keep policy (auth, retry) in the adapter. Done when the parse seam has a live-shaped fixture test.

## Gotchas

- `noUncheckedIndexedAccess` is on — array access returns `T | undefined`; use `!` only after a bounds check.
- DuckDuckGo HTML is scraped, not API'd: `parseResults()` degrades to empty results when DDG changes markup, with no error. Verify against real fixtures.
- Exa MCP is remote JSON-RPC over SSE — network errors are expected; the adapter retries once, the auto-router falls back to DDG.
