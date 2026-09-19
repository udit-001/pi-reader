# Fetch pipeline

Reference for `fetch/fetch.ts`, `fetch/handlers/`, and `cache/`. Open this before touching the fetch chain, the SSRF/network guard, or the cache — and when debugging a URL that returns nothing. Param semantics live in the schema descriptions in `index.ts`.

## The chain

`fetchContent()` tries tiers in order until one serves the URL:

1. **Local** — verbatim markdown/text/JSON passthrough; HTML → Defuddle → Markdown; Next.js RSC flight decode when Readability finds nothing; regex extraction last; bot-walled pages get one `curl` retry with a real Chrome profile before leaving the machine.
2. **Jina Reader** — renders JS; free.
3. **markdown.new** — free.
4. **Exa MCP** — quota'd, last resort.

A tier's output thinner than `MIN_FALLBACK_CONTENT` (50 chars) is discarded and the chain continues.

Known-site URLs short-circuit the chain: `fetch/handlers/registry.ts` resolves a handler (GitHub, GitLab, 8 registries, Wikipedia, Reddit, HN, Stack Exchange, arXiv, RSS/Atom feeds, next-flight) and `fetchWithHandler()` renders structured content. `mode: "raw"` skips handlers, extraction, topic, and cache — the exact response body, labeled with status and content type.

## Constants (`fetch/fetch.ts`)

| Constant | Value | Why |
|----------|-------|-----|
| `FETCH_TIMEOUT_MS` | 30s | per fetch |
| `FALLBACK_TIMEOUT_MS` | 20s | per remote tier |
| `FETCH_BODY_CAP` | 5 MB | response bytes buffered per fetch (OOM guard) |
| `DEFAULT_MAX_CHARS` | 20_000 | per page returned; a real reading sample, not a teaser |
| `CACHE_TTL_HOURS` | 168 | 7 days |

## SSRF / network guard

Every path to content goes through `httpGet` (`fetch/handlers/handler.ts`):

- `assertPublicTarget` blocks loopback, link-local, and private-range targets (cloud metadata, intranet).
- A DNS preflight resolves the hostname once and blocks when any resolved address is private.
- Redirects are followed manually so every hop re-validates against the same check (`MAX_REDIRECTS` cap).

The escape hatch is `allowPrivateNetwork: true` in `~/.pi/agent/pi-reader.json`. Route new fetch paths through `httpGet` so they inherit the guard — the test suite pins this.

## Topic extraction

`topic` selects the matching sections via `fetch/topic.ts` (`matchTopic`) instead of returning full content. Applies after extraction, before the char cap.

## Cache (`cache/`)

- Root: `~/.pi/agent/pi-reader-cache/`. Clone checkouts deliberately live outside it (see [github.md](github.md)) — a checkout deleted mid-session under the agent's `read` is worse than disk.
- URL canonicalization (`canonicalize`): drop fragments and tracking params (`utm_*`, `fbclid`, …), sort the query, lowercase the host. The canonical form is both the cache key and the URL actually fetched.
- Content lives on disk; a sqlite index (`cachedb.ts`) tracks metadata. `prune()` enforces the TTL.
- Search results cache separately under `search/` with a 1-hour TTL — see [search-providers.md](search-providers.md).
