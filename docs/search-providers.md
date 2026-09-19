# Search providers

Reference for `search/` and `config.ts`. Open this before touching a provider, auto-routing, recency/page behavior, or Exa key/config handling. Param semantics live in the schema descriptions in `index.ts`.

## Routing (`search/search.ts`)

- `provider: "auto"` → `resolveAutoRoute()`: Exa-shaped params (`category`, `includeContent`, `includeSummary`, non-empty `domains`) route Exa-first with DDG fallback; anything else routes DDG-first with Exa fallback. Pure function — pin changes in `test/routing.test.ts`.
- `wikipedia`, `hn`, `context7` are free, keyless, explicit-only. When DDG and Exa both fail, this free-provider tier runs as the last fallback.
- Exa runs one of two calls: a plain query → `searchExaMcp`; any Exa-shaped param → `searchExaAdvanced`.
- Successful results are cached for 1 hour (key: query + provider + options). Exa results are never cached — they cost quota.

## DuckDuckGo: the ddgs/uvx path (`search/ddgs-uv.ts`)

- Primary: `uvx ddgs text` — TLS fingerprinting and VQD token handling for free. JSON output to a tmp file, parsed, tmp removed in `finally`.
- uvx resolution: official install location first (`~/.local/bin/uvx`, `.exe` on Windows), then bare `uvx` so PATH resolves it (brew, apt, pip, scoop). Missing → auto-installed once via the official installer, then probed again.
- Session-start warm-up (`warmDdgs`): once per process, fire-and-forget, never blocks or throws. Moves the one-time uv/ddgs download off the first search; failure is silent because the HTML fallback covers search.
- Degraded fallback: HTML scraping. Its results carry a visible notice so the agent knows quality dropped.
- `recency` maps to ddgs `-t` letter codes via `REGENCY_TO_TIMELIMIT` — the single source of truth for both the ddgs and HTML adapters. `page` maps to `-p`. `domains` become `site:` / `-site:` operators.

## Exa MCP (`search/exa-mcp.ts`)

- Remote JSON-RPC over SSE — network errors are expected: the adapter retries once, then auto-routing falls back to DDG.
- Key resolution, in order: `~/.pi/agent/pi-reader.json` (`exa.apiKey`, written by the wizard) → `EXA_API_KEY` env var. `mcp.json` is a wizard *import source*, never a runtime key source. Resolution is lazy and cached; `resetExaKeyCache()` after a wizard write makes a new key live without restart.
- Keyless and rate-limited failures call `noteExaIssue()`; the entry consumes it once per tool call (`consumeExaIssue` in `finally`), so the hint fires once per tool call, not per provider attempt.

## Config (`config.ts`)

- Single file: `~/.pi/agent/pi-reader.json`. Writes are atomic (tmp + rename); reads are forgiving — missing or malformed resolves to null.
- Keys in use: `exa.apiKey`, `exa.url` (endpoint override), `allowPrivateNetwork` (fetch-guard escape hatch — [fetch-pipeline.md](fetch-pipeline.md)), `maxRepoSizeMB` (clone size gate — [github.md](github.md)), `hints.mcpDuplicate` (persisted dedupe flag, below).

## Wizard (`/exa-setup`, `search/exa-setup.ts`)

- Validates, previews, and writes the key atomically. Imports a key from `mcp.json` when present (checks `~/.pi/agent/mcp.json`, `~/.pi/mcp.json`, `./.pi/mcp.json`) and dedupes the entry.
- Duplicate detection: an `mcp.json` exa entry with `directTools` puts Exa's raw tools beside `web_search` in every session. Detected at session start; the full explanation fires once (persisted via `hints.mcpDuplicate`), later sessions get a brief reminder while the condition persists. Both self-heal when the entry is removed.
- The wizard opens only via `/exa-setup` — it needs keyboard focus, so it prints a hint rather than auto-opening.
