# AGENTS.md — pi-reader

Pi extension: web search (DuckDuckGo + Exa MCP) and URL→Markdown fetch. Two providers, zero config.

## Build

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts
```

Gate for every commit: typecheck and the full suite pass. No build step — TypeScript runs directly via Node's `--test` loader.

## Architecture

**Seam model.** The entry (`index.ts`) is thin — registers tools, maps params, formats output. Depth lives in the deep modules, grouped by responsibility:

| Module | Seam |
|--------|------|
| `search/search.ts` | Provider seam: routing, fallback, answer synthesis |
| `search/ddgs-uv.ts` | ddgs adapter seam: shared argv plan (`buildDdgsArgs`), private tmp dir, warm-up, recency/license maps |
| `search/news.ts`, `search/images.ts`, `search/duckduckgo.ts` | ddgs verticals: news, images, and the HTML degrade |
| `search/videos.ts` | Videos vertical: direct DDG v.js client, keyless |
| `search/papers.ts`, `search/paper-backend.ts`, `search/europepmc.ts` | Papers vertical: backend dispatch (`index`), shared record seam, Europe PMC backend |
| `fetch/fetch.ts` | URL→Markdown: local extraction → free services → Exa fallback |
| `fetch/handlers/` | Per-site structured rendering (GitHub, registries, HN, feeds, …) |
| `fetch/github-clone.ts` | Local checkouts: `ensureClone` (gh→git, size gate, runtime cache), `renderRepoView` |
| `fetch/github-issue-pr.ts` | Issue/PR documents: gh-first with REST fallback, one deterministic renderer |
| `cache/cache.ts` | Fetch cache on disk: lookup/store/prune, sqlite index in `cachedb.ts` |
| `config.ts` | All config file I/O: `~/.pi/agent/pi-reader.json`, atomic |
| `search/exa-mcp.ts` | Exa MCP transport: JSON-RPC, SSE, key resolution |
| `search/exa-setup.ts` | Wizard TUI: key validation, save, import-from-mcp.json |
| `search/exa-issue.ts` | Shared state: classify Exa failures for one-shot hints |

**Two adapters = real seam.** One adapter is hypothetical; two is the proof. A third provider satisfies `SearchProvider` in `search/search.ts` and registers in the provider map. The auto-router `autoChain()` decides the `[primary, failure-fallback]` pair by intent params — a pure function, tested separately.

**Fetch chain priority:** local (Defuddle, regex) → Jina Reader (renders JS) → markdown.new → Exa MCP. Free tiers first; Exa is the quota'd last resort.

**Deep dives (docs/).** This file carries seams and rules; the docs carry mechanism. Open one when its trigger fires:

- [`docs/fetch-pipeline.md`](docs/fetch-pipeline.md) — the full chain, SSRF guard, body caps, timeouts, cache layout. Open before touching the fetch chain, the network guard, or the cache, or when debugging a URL that returns nothing.
- [`docs/search-providers.md`](docs/search-providers.md) — routing, the ddgs/uvx path and warm-up, Exa transport, search cache, key resolution, the wizard. Open before touching a provider, routing, recency/page behavior, or config/key handling.
- [`docs/github.md`](docs/github.md) — repo checkouts (size gate, runtime cache) and issue/PR rendering (gh-first, REST fallback, one renderer). Open before touching `github-clone.ts` or `github-issue-pr.ts`.
- [`docs/papers.md`](docs/papers.md) — the papers vertical: backend pair (OpenAlex + Europe PMC), in-band error contract, `mailto` politeness, citation-graph approximation. Open before touching the papers vertical, scholarly search, or citation traversal.

## Conventions

- **Imports:** `.ts` extensions everywhere (`import { x } from "./foo.ts"`). NodeNext resolution.
- **Schemas:** Typebox (`Type.Object`, `Type.Union`, `Type.Literal`) — tool params are Typebox, not zod. Schema descriptions in `index.ts` are the single param reference (the README carries none) — change a param's behavior and its description in the same commit.
- **Errors:** tool `execute()` returns errors in band: try/catch → `{ content: [{ type: "text", text: <actionable hint> }] }`, so the agent always gets a recovery path instead of a throw.
- **Exa issues:** adapters call `noteExaIssue()` on rate-limit or missing-key; the entry calls `consumeExaIssue()` once in `finally` — the hint fires once per tool call, not per provider attempt.
- **Tests:** `node:test` + `node:assert/strict`, one `test()` per behavior, fixtures in-line. Test the parse seam, not the HTTP layer.
- **Config:** `config.ts` owns all file I/O. Writes are atomic (tmp + rename); reads are forgiving — missing or malformed reads as null.
- **Docs:** edits to `docs/` or this file follow the writing-great-skills framework — one single source of truth per meaning, no-ops pruned sentence by sentence, duplication collapsed, leading words over restatements.

## Adding a feature

Every branch ends the same way: typecheck green, the touched test file green.

1. **Search provider** — add an adapter satisfying `SearchProvider` in `search/search.ts`, register it in the provider map, and extend `autoChain()` if it has Exa-equivalent intent params (`test/routing.test.ts`).
2. **Fetch fallback** — insert into the chain in `fetch/fetch.ts` before Exa; it must be free or Exa-backed.
3. **Tool param** — Typebox schema in `index.ts`, pass-through to the deep module, routing test in `test/routing.test.ts` when it affects auto-routing.
4. **Exa tool** — wrapper in `search/exa-mcp.ts`, exposed via `searchExaAdvanced()` or a new export; test the parse seam.

## Gotchas

- `noUncheckedIndexedAccess` is on — array access returns `T | undefined`; use `!` only after a bounds check.
- DuckDuckGo HTML is scraped, not API'd: `parseResults()` breaks silently (empty results) when DDG changes markup. Verify with real fixtures.
- Exa MCP is remote JSON-RPC over SSE — network errors are expected; the adapter retries once, the auto-router falls back to DDG.
