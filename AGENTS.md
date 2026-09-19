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
| `fetch/fetch.ts` | URL→Markdown: local extraction → free services → Exa fallback |
| `fetch/handlers/` | Per-site structured rendering (GitHub, registries, HN, feeds, …) |
| `fetch/github-clone.ts` | Local checkouts: `ensureClone` (gh→git, size gate, runtime cache), `renderRepoView` |
| `cache/cache.ts` | Fetch cache on disk: lookup/store/prune, sqlite index in `cachedb.ts` |
| `config.ts` | All config file I/O: `~/.pi/agent/pi-reader.json`, atomic |
| `search/exa-mcp.ts` | Exa MCP transport: JSON-RPC, SSE, key resolution |
| `search/exa-setup.ts` | Wizard TUI: key validation, save, import-from-mcp.json |
| `search/exa-issue.ts` | Shared state: classify Exa failures for one-shot hints |

**Two adapters = real seam.** One adapter is hypothetical; two is the proof. A third provider satisfies `SearchProvider` in `search/search.ts` and registers in the provider map. The auto-router `resolveAutoRoute()` decides order by intent params — a pure function, tested separately.

**Fetch chain priority:** local (Defuddle, regex) → Jina Reader (renders JS) → markdown.new → Exa MCP. Free tiers first; Exa is the quota'd last resort.

## Conventions

- **Imports:** `.ts` extensions everywhere (`import { x } from "./foo.ts"`). NodeNext resolution.
- **Schemas:** Typebox (`Type.Object`, `Type.Union`, `Type.Literal`) — tool params are Typebox, not zod.
- **Errors:** tool `execute()` returns errors in band: try/catch → `{ content: [{ type: "text", text: <actionable hint> }] }`, so the agent always gets a recovery path instead of a throw.
- **Exa issues:** adapters call `noteExaIssue()` on rate-limit or missing-key; the entry calls `consumeExaIssue()` once in `finally` — the hint fires once per tool call, not per provider attempt.
- **Tests:** `node:test` + `node:assert/strict`, one `test()` per behavior, fixtures in-line. Test the parse seam, not the HTTP layer.
- **Config:** `config.ts` owns all file I/O. Writes are atomic (tmp + rename); reads are forgiving — missing or malformed reads as null.

## Adding a feature

Every branch ends the same way: typecheck green, the touched test file green.

1. **Search provider** — add an adapter satisfying `SearchProvider` in `search/search.ts`, register it in the provider map, and extend `resolveAutoRoute()` if it has Exa-equivalent intent params (`test/routing.test.ts`).
2. **Fetch fallback** — insert into the chain in `fetch/fetch.ts` before Exa; it must be free or Exa-backed.
3. **Tool param** — Typebox schema in `index.ts`, pass-through to the deep module, routing test in `test/routing.test.ts` when it affects auto-routing.
4. **Exa tool** — wrapper in `search/exa-mcp.ts`, exposed via `searchExaAdvanced()` or a new export; test the parse seam.

## Gotchas

- `noUncheckedIndexedAccess` is on — array access returns `T | undefined`; use `!` only after a bounds check.
- DuckDuckGo HTML is scraped, not API'd: `parseResults()` breaks silently (empty results) when DDG changes markup. Verify with real fixtures.
- Exa MCP is remote JSON-RPC over SSE — network errors are expected; the adapter retries once, the auto-router falls back to DDG.
- The wizard opens only via `/exa-setup` (it needs keyboard focus, so it prints a hint rather than auto-opening).
