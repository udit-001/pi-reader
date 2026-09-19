# AGENTS.md — pi-reader

Pi extension: web search (DuckDuckGo + Exa MCP) and URL→Markdown fetch. Two providers, zero config.

## Build

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts
```

Typecheck and test must both pass before any commit. No build step — TypeScript runs directly via Node's `--test` loader.

## Architecture

**Seam model.** Two real adapters (DuckDuckGo, Exa MCP) behind a `SearchProvider` interface in `search/search.ts`. The entry (`index.ts`) is thin — registers tools, maps params, formats output. Depth lives in the deep modules:

| Module | Seam |
|--------|------|
| `search/search.ts` | Provider seam: routing, fallback, answer synthesis |
| `fetch/fetch.ts` | URL→Markdown: local extraction → free services → Exa fallback |
| `config.ts` | Config reads/writes: `~/.pi/agent/pi-reader.json`, atomic |
| `search/exa-mcp.ts` | Exa MCP transport: JSON-RPC, SSE, key resolution |
| `search/exa-setup.ts` | Wizard TUI: key validation, save, import-from-mcp.json |
| `search/exa-issue.ts` | Shared state: classify Exa failures for one-shot hints |

**Two adapters = real seam.** One adapter is hypothetical; two is the proof. If you add a third provider, satisfy the `SearchProvider` interface in `search/search.ts` and register it in the provider map. The auto-router in `resolveAutoRoute()` decides order by intent params — it's a pure function, test it separately.

**Fetch chain priority:** local (Defuddle, regex) → Jina Reader (free, renders JS) → markdown.new (free) → Exa MCP (quota). Never skip the free tiers. Exa is last-resort, not first-choice.

## Conventions

- **Imports:** `.ts` extensions everywhere (`import { x } from "./foo.ts"`). NodeNext module resolution.
- **Schemas:** Typebox (`Type.Object`, `Type.Union`, `Type.Literal`). Tool params are Typebox schemas, not zod.
- **Errors:** Tool `execute()` wraps in try/catch, returns `{ content: [{ type: "text", text: ... }] }` on error. Never throw from tool handlers.
- **Exa issues:** Adapters call `noteExaIssue()` on rate-limit or missing-key. Entry calls `consumeExaIssue()` once in `finally` block — the hint fires once per tool call, not per provider attempt.
- **Tests:** `node:test` + `node:assert/strict`. One `test()` per behavior. Fixture HTML in-line (not files). Test the parse seam, not the HTTP layer.
- **Config:** `config.ts` handles all file I/O. Atomic writes (tmp + rename). Reads are forgiving — missing or malformed returns null, never throws.

## Adding a feature

1. **New search provider?** Add adapter, satisfy `SearchProvider` in `search/search.ts`, update `resolveAutoRoute()` if it has Exa-equivalent intent params.
2. **New fetch fallback?** Add to the chain in  `fetch/fetch.ts` — it must be free or Exa-backed. Insert before Exa in the priority order.
3. **New tool param?** Add Typebox schema in `index.ts`, pass through to the deep module, add test in `test/routing.test.ts` if it affects auto-routing.
4. **New Exa tool?** Add wrapper in `exa-mcp.ts`, expose via `searchExaAdvanced()` or a new export. Test the parse seam.

## Gotchas

- `noUncheckedIndexedAccess` is on — array access returns `T | undefined`. Use `!` only when you've bounds-checked.
- DuckDuckGo HTML is scraped, not API'd. The `parseResults()` regex is fragile — if DDG changes their HTML, the parser breaks silently (returns empty). Test with real fixtures.
- Exa MCP is remote JSON-RPC over SSE. Network errors are expected. The adapter retries once; the auto-router catches and falls back to DDG.
- The wizard never auto-opens. It prints a hint; the user runs `/exa-setup` manually. This is intentional — the wizard needs keyboard focus.
