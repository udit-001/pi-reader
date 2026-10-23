# AGENTS.md — pi-reader

Pi extension: `web_search`, `web_fetch` (URL→Markdown), and `web_crawl` (bounded site sweep). Zero config on the default path.

## Gate

`npm run typecheck && npm test` — both green before every commit.

Papers wire-drift (real API calls, metered, skipped by default): `PIWEB_LIVE_SMOKE=1 node --test test/papers-live-smoke.test.ts`. Run it whenever a papers request shape, projection, or error mapping changes.

## The seam model

The entry (`index.ts`) stays thin; depth lives in the deep modules:

| Module | Seam |
|--------|------|
| `search/search.ts` | Provider seam |
| `search/ddgs-uv.ts`, `duckduckgo.ts`, `news.ts`, `images.ts`, `videos.ts` | ddgs seam and its verticals |
| `search/papers.ts`, `paper-backend.ts`, `europepmc.ts` | Papers vertical |
| `search/openai.ts` | Codex web search |
| `search/mcp-client.ts`, `exa-mcp.ts`, `parallel-mcp.ts` | MCP glue, remote providers |
| `search/key-setup.ts`, `exa-setup.ts`, `parallel-setup.ts`, `openalex-setup.ts` | Setup wizards |
| `search/exa-issue.ts`, `redact.ts` | Issue hints, secret redaction |
| `fetch/fetch.ts`, `curl-fetch.ts` | URL→Markdown chain |
| `fetch/crawl.ts` | Sweep interface |
| `fetch/crawl-uv.ts` | trafilatura driver |
| `fetch/handlers/`, `topic.ts` | Per-site rendering, topic extraction |
| `fetch/github-clone.ts`, `github-issue-pr.ts` | Repo checkouts, issue/PR rendering |
| `cache/cache.ts` | Fetch cache |
| `config.ts` | Config file I/O |
| `render.ts` | Transcript view |

**Two adapters = real seam.** One adapter is hypothetical; two is the proof.

## Deep dives

This file carries seams and rules; `docs/` carries mechanism. Open the doc whose subject you are about to change.

- [`docs/fetch-pipeline.md`](docs/fetch-pipeline.md) — the fetch chain, its guard, caps, timeouts, cache.
- [`docs/search-providers.md`](docs/search-providers.md) — routing, the ddgs/uvx path, every provider, keys, config, wizards.
- [`docs/github.md`](docs/github.md) — repo checkouts and issue/PR rendering.
- [`docs/papers.md`](docs/papers.md) — the papers vertical: backends, record shape, citation walks, metering.

## Conventions

- **Schemas:** Typebox only. The schema descriptions in `index.ts` are the single param reference — a param's behavior and its description change in the same commit.
- **Errors in band:** the agent gets the recovery path, never a throw.
- **Exa issues:** adapters `noteExaIssue()`; the entry consumes the hint once per call.
- **Tests:** `node:test` + `node:assert/strict`, one `test()` per behavior, fixtures inline. Test the parse seam, not the HTTP layer.
- **Config:** `config.ts` owns all file I/O. Reads are forgiving: missing or malformed config is null, never a throw at startup.
- **Docs:** one owner per meaning. A fact stated in two files is a bug in the second one.

## Adding a feature

1. **Search provider** — adapter satisfying `SearchProvider` in `search/search.ts`, registered in the provider map; extend `autoChain()` only for Exa-equivalent intent params. Done when `test/routing.test.ts` pins both the route and the fallback.
2. **Fetch fallback** — insert into the chain in `fetch/fetch.ts` before Exa; it must be free or Exa-backed. Done when a fixture URL resolves through the new tier and the tiers below it still pass.
3. **Tool param** — Typebox schema in `index.ts`, pass-through to the deep module, routing test when it moves `autoChain()`. Done when the schema description, the behavior, and the test agree.
4. **MCP tool** — wrapper on `search/mcp-client.ts` exposed through its adapter (`searchExaAdvanced()` or a new export); keep policy (auth, retry) in the adapter. Done when the parse seam has a live-shaped fixture test.

## Gotchas

- `noUncheckedIndexedAccess` is on — array access returns `T | undefined`; use `!` only after a bounds check.
- DuckDuckGo HTML is scraped, not API'd: `parseResults()` degrades to empty results when DDG changes markup, with no error. Verify against real fixtures.
- Exa MCP is remote JSON-RPC over SSE: a network error is an expected outcome, not a bug to chase.
