# Search providers

Reference for `search/` and `config.ts`. Open this before touching a provider, auto-routing, recency/page behavior, or Exa key/config handling. Param semantics live in the schema descriptions in `index.ts`.

## Routing (`search/search.ts`)

- `provider: "auto"` → `autoChain()`: the single routing seam — a pure function of intent returning `[primary, failure-fallback]` provider names. Exa-shaped params (`category`, `includeContent`, `includeSummary`, non-empty `domains`) route Exa-first with DDG fallback; anything else routes DDG-first with Exa fallback. Pin changes in `test/routing.test.ts`.
- For news intent (`category: "news"`) the chain is the fidelity ladder's first two rungs: Exa semantic news primary when alive; on an Exa *failure* (quota death, missing key) the news vertical takes over with dates and outlets, and its own degrade lands on text. Fallback fires on provider failure (throw) only — never on empty results. A degraded response carries `degraded: true` on the `SearchResponse`, and `shouldCacheSearch()` refuses to cache it — so a news-intent query that fell all the way to text is not pinned for the TTL and the ladder recovers.
- `wikipedia`, `hn`, `context7`, `news`, and `images` are free, keyless, explicit-only — never chosen as the auto *primary* and never in the fallback chain for non-news intent. When DDG and Exa both fail, the free-provider tier (`wikipedia`/`hn`/`context7`) runs as the last fallback.
- Exa runs one of two calls: a plain query → `searchExaMcp`; any Exa-shaped param → `searchExaAdvanced`.
- Successful results are cached for 1 hour (key: query + provider + options). Exa results are never cached — they cost quota.

## DuckDuckGo: the ddgs/uvx path (`search/ddgs-uv.ts`)

- Primary: `uvx ddgs text` — TLS fingerprinting and VQD token handling for free. JSON output lands in a private per-call dir (`mkdtemp`, 0700 — a local user can't pre-place a symlink at a guessable path to feed fake results), removed in `finally`.
- uvx resolution: official install location first (`~/.local/bin/uvx`, `.exe` on Windows), then bare `uvx` so PATH resolves it (brew, apt, pip, scoop). Missing → auto-installed once via the official installer, then probed again.
- Session-start warm-up (`warmDdgs`): once per process, fire-and-forget, never blocks or throws. Moves the one-time uv/ddgs download off the first search; failure is silent because the HTML fallback covers search. The one exception: when warm-up *installs* uv, the user is told — `curl | sh` from astral.sh never runs invisibly.
- Degraded fallback: HTML scraping. Its results carry a visible notice so the agent knows quality dropped.
- `recency` maps to ddgs `-t` letter codes via `REGENCY_TO_TIMELIMIT` — the single source of truth for both the ddgs and HTML adapters, and for the news vertical. `page` maps to `-p`. `domains` become `site:` / `-site:` operators.

## News vertical (`search/news.ts`)

- `provider: "news"` → `uvx ddgs news` (bing/duckduckgo/yahoo engines — free, keyless). The argv plan is the text plan generalized to a subcommand param (`buildDdgsArgs`); news accepts the same flag set including `-t` d/w/m/y and `-p`.
- Normalization is verbatim — invents nothing: `date`→`publishedDate` (clean ISO and source junk like `"Opinion2 days ago"` pass through unmodified), `body`→`snippet`, `source` outlet→`author`, `image` dropped, url-less rows dropped. `domains` is not supported — `newsViaDdgs` strips it before the shared seam, matching `imagesViaDdgs`.
- Degrade, don't fail: uvx missing or the ddgs news call failing → text search (same query, same window) with a visible `[News: …]` notice on the last result; the provider label then reports `duckduckgo` so a degraded answer never masquerades as news.
- The answer builder and the tool's result lines/details render `publishedDate` and `author` for every provider (news and Exa alike).

## Images vertical (`search/images.ts`)

- `provider: "images"` → `uvx ddgs images` (free, keyless). Explicit-only — it lives outside `autoProviders`, and `AutoProviderName` (the chain's key type) doesn't include it, so the compiler holds it out of the auto chain.
- Normalization is agent-POV: `image`→`url` (the direct, hotlinkable origin — the thumbnail and the source-page url are dropped), `title` verbatim, and dims+source collapse into the snippet (`W×H · via source`; each token optional, non-numeric dims ignored, image-less rows dropped). The default renderer needs no changes.
- No degrade-to-text: text results cannot substitute for images, so failure surfaces as an in-band error instead of fake results.
- `license` (`share|commercial|modify`) maps to the ddgs `-lic` request filter via `LICENSE_TO_FLAG` (values verified live); `"any"` is the server default, so no flag is emitted.
- The images engines reject ddgs `-t` outright (`KeyError` on every backend, verified live — the CLI `--help` lies), so `buildDdgsArgs` drops timelimit on the images path and `recency` is documented as unsupported in the schema description.

## Videos vertical (`search/videos.ts`)

- `provider: "videos"` → **direct DDG v.js client** (free, keyless) — the one vertical that bypasses ddgs. Reason: ddgs's videos engine is the only backend behind the vertical, and its HTTP client (`primp`, TLS-fingerprint-spoofed) is 403-banned from `v.js`; the endpoint itself is open to a plain browser-UA fetch (verified live). Two GETs: `duckduckgo.com/?q=` → regex out the VQD token → `duckduckgo.com/v.js?…&vqd=…` → JSON rows.
- Explicit-only — outside `autoProviders` (compiler-held out of the chain), dispatched only when the agent names it.
- Normalization is agent-POV: `content`→`url` (the watch URL — the agent acts on the video, not a page), `uploader`→`author` (falls back to `publisher`), `published`→`publishedDate` verbatim, and duration+views+via collapse into the snippet (`13:59:10 · 1.2M views · via freeCodeCamp.org`). Dropped: `embed_html`, `embed_url`, `image_token`, `images`, `description`, `thumbnail_*` — no agent verb acts on them.
- `recency` binds at the source via the `f=publishedAfter:{d|w|m|y}` slot of the v.js filter string; `page` via `s=(page-1)*60`. `domains` is not supported.
- No degrade-to-text. The fragile seam is the VQD regex (markup-pinned fixture test); a missing token, non-200, or non-JSON response surfaces as an actionable in-band error naming the cause and the text + `domains: ["youtube.com"]` workaround. No 403 retries — a fingerprint ban isn't retry-recoverable, and the boring-UA client exists precisely to avoid earning one.

## Papers vertical (`search/papers.ts`)

- Explicit-only like the other verticals; two backends behind one dispatch — `index` picks OpenAlex (default) or Europe PMC for biomedical full text — both normalizing into one shared record shape, failure always in-band. The rationale — why in-band rather than degrade, why explicit-only, why this backend pair (and why Semantic Scholar waits), the key + metering contract, and the citation-graph approximation — is [papers.md](papers.md).

## Exa MCP (`search/exa-mcp.ts`)

- Remote JSON-RPC over SSE — network errors are expected: the adapter retries once, then auto-routing falls back to DDG.
- Key resolution, in order: `~/.pi/agent/pi-reader.json` (`exa.apiKey`, written by the wizard) → `EXA_API_KEY` env var. `mcp.json` is a wizard *import source*, never a runtime key source. Resolution is lazy and cached; `resetExaKeyCache()` after a wizard write makes a new key live without restart.
- Keyless and rate-limited failures call `noteExaIssue()`; the entry consumes it once per tool call (`consumeExaIssue` in `finally`), so the hint fires once per tool call, not per provider attempt. Every error leaving `callExaTool` passes `redactKey()` — the key never reaches the agent transcript (short keys are skipped: they occur in ordinary text).

## Config (`config.ts`)

- Single file: `~/.pi/agent/pi-reader.json`. Writes are atomic (tmp + rename); reads are forgiving — missing or malformed resolves to null.
- Keys in use: `exa.apiKey`, `exa.url` (endpoint override), `papers.openalexApiKey` (OpenAlex metering — [papers.md](papers.md)), `allowPrivateNetwork` (fetch-guard escape hatch — [fetch-pipeline.md](fetch-pipeline.md)), `maxRepoSizeMB` (clone size gate — [github.md](github.md)), `hints.mcpDuplicate` (persisted dedupe flag, below).

## Wizard (`/exa-setup`, `/openalex-setup`; skeleton in `search/key-setup.ts`)

- One shared skeleton (`search/key-setup.ts`) owns the flow — intro → dashboard → hidden paste → validate → save (masked preview, atomic write) → done — plus the spinner, redaction, the headless manual-path fallback, and the reopen guard. A provider's wizard is a spec plus a thin subclass for its extras.
- `/exa-setup` (`search/exa-setup.ts`) validates, previews, and writes the key atomically. Imports a key from `mcp.json` when present (checks `~/.pi/agent/mcp.json`, `~/.pi/mcp.json`, `./.pi/mcp.json`) and dedupes the entry — those two places live in the Exa instance, never the skeleton.
- `/openalex-setup` (`search/openalex-setup.ts`) is the thinnest instance: validation is one free singleton work lookup (401/403 → key rejected, 429 → rate-limited, classified by the same grammar as the papers error contract), and the done screen reads the real daily budget and reset from the free `/rate-limit` endpoint.
- Duplicate detection: an `mcp.json` exa entry with `directTools` puts Exa's raw tools beside `web_search` in every session. Detected at session start; the full explanation fires once (persisted via `hints.mcpDuplicate`), later sessions get a brief reminder while the condition persists. Both self-heal when the entry is removed.
- A wizard opens only via its command — it needs keyboard focus, so headless mode prints the manual path (config shape + key URL) instead.
