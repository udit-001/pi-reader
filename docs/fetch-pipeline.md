# Fetch pipeline

Reference for `fetch/fetch.ts`, `fetch/curl-fetch.ts`, `fetch/topic.ts`, `fetch/handlers/`, `cache/`. Values, thresholds, and param semantics live in the code and in the schema descriptions in `index.ts`; this doc carries the ordering and the reasons for it.

## The chain

`fetchContent()` walks tiers in order until one serves the URL:

1. **Local** — passthrough, Defuddle, Next.js RSC decode, regex last. A bot-walled page gets one `curl` retry with a real Chrome profile (`curl-fetch.ts`) before leaving the machine: Node's fetch earns 403s from sites that accept the same request over system curl.
2. **Jina Reader** — renders JS; free.
3. **markdown.new** — free.
4. **Exa MCP** — quota'd, so last.

A tier thinner than `MIN_FALLBACK_CONTENT` is discarded and the chain continues.

**Known sites short-circuit the chain.** `fetch/handlers/registry.ts` resolves a handler and `fetchWithHandler()` renders structure instead of text. `mode: "raw"` skips handlers, extraction, topic, and cache — except a handler that opts in with `fetchRaw` (`MagpiHandler`): a site whose public URL is a JS shell declares where its canonical body lives. orcid.org is the live case.

## The guard

Every path to content goes through `httpGet` (`fetch/handlers/handler.ts`), and the test suite pins that. Four layers, each closing a different hole:

- `assertPublicTarget` blocks loopback, link-local, and private ranges — cloud metadata and intranet included.
- A DNS preflight resolves once and blocks when any address is private.
- A process-wide dispatcher wraps `dns.lookup` (`guardedLookup`) so no address connects unvalidated; the preflight alone leaves a rebinding window.
- Redirects are followed by hand so every hop re-runs the preflight.

Escape hatch: `allowPrivateNetwork: true` in `~/.pi/agent/pi-reader.json`.

## Topic

`topic` selects matching sections through `matchTopic` (`fetch/topic.ts`) after extraction and before the char cap, so a matched section is not truncated by the page it shares with unmatched ones.

## Cache

- `canonicalize` drops fragments and tracking params (`utm_*`, `fbclid`, …), sorts the query, lowercases the host. The canonical form is both the cache key and the URL actually fetched, so a tracking-tagged copy and its clean form cannot fork into two entries.
- Repo checkouts deliberately live outside the cache root: an LRU that evicts a checkout mid-session pulls the path out from under the agent's next `read`. See [github.md](github.md).
- Search results cache separately from pages, on their own shorter TTL — see [search-providers.md](search-providers.md).
