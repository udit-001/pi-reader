# Papers vertical

Reference for `search/papers.ts` (backend dispatch), `search/paper-backend.ts` (shared record seam), and `search/europepmc.ts` (Europe PMC backend). Open before touching the papers vertical, scholarly search, citation traversal, or paper-record normalization. Param semantics live in the schema descriptions in `index.ts`; this doc carries the reasons behind the choices.

## Shape

- `provider: "papers"` → `searchPapers()`: the backend dispatcher. `index` picks the backend — `"openalex"` (default) or `"europepmc"` — and both normalize into the one `PaperRecord` shape (`year`, `authors`, `venue`, `citedBy`, `oaUrl`, `doi`, `retracted`, `topic`, `type` flat keys beside the standard `title`/`url`/`snippet`). Enrichment keys are absent-tolerant — present when the API provides them, never invented. The snippet renders the `retracted` badge before the open-access badge (a retraction changes how every other token is weighed) and the topic token after it. `search/paper-backend.ts` owns the record, the snippet builder, the URL policy, and the error contract; `normalize*` is the only backend fork point, so downstream (entry rendering, the shared helpers in `paper-backend.ts`) never branches on the backend.
- Failure throws `PaperError`, whose message is built by `paperError()` — the entry passes it verbatim. Three statuses: `no-results`, `backend-down`, `malformed`, each naming the backend, the retry `index`, and a manual-DOI escape hatch. The entry's generic error rewriter never touches these — the retry hint IS the actionability.

## The record URL: most fetchable copy wins

Each row's `url` is the canonical place the agent acts on — the link a human clicks and the fetch chain resolves. Both backends rank their candidates through `chooseFetchableUrl` in `search/paper-backend.ts` — one URL policy for the vertical, the rank ladder in its comment. The row points at the most fetchable copy the work carries; the bare DOI always rides the `doi` key, so citation seeds and the `DOI:` meta line lose nothing when the URL is a copy, and a closed work with no copy anywhere keeps the doi.org link.

The ordering is the point — verified live: doi.org rate-limits per IP, so 429s bite when an agent walks a result set of DOI links, and the redirect lands on the most bot-walled corner of publishing (Cloudflare challenges, auth transit pages) while the PMC/DOAJ/repo copies fetch keylessly. One wire fact drives the adapters: OpenAlex's own `landing_page_url` is usually the doi.org form, so the OpenAlex adapter reads `locations` for the copies, and Europe PMC ranks its PMC copy over its DOI.

## Why in-band failure, not degrade-to-text

A text-search result is not a paper record — no substitutes exist. The news vertical degrades to text because a dated snippet legitimately answers a news query; papers can't play that trick: a row without year/venue/DOI cannot be cited, and a web page masquerading as a paper would poison the citation work the agent builds on it. So every papers failure surfaces as an in-band error with the recovery path, and `shouldCacheSearch()`'s degraded-flag refusal holds for papers too — a degraded papers response is never cached under the papers key.

## Why explicit-only, outside the auto chain

`provider: "papers"` is never chosen by `autoChain()` — not as primary, not as fallback (pinned in the routing tests). The danger runs both directions: a broad web-intent query silently answered with scholarly metadata serves an abstract when the agent wanted a working page; a scholarly-intent query answered with a web page throws away the citation graph. A deliberate dispatch keeps both semantics visible, and `index`/`filters` never hijack routing — the papers vertical reads its own params only.

## Why OpenAlex + Europe PMC

- **OpenAlex** is breadth: ~250M works across all disciplines, one JSON endpoint. It works keylessly (smaller metered budget) and takes a free key — the key + metering contract below. Its metadata is the universal index, and its `locations` list carries every copy — PMC, DOAJ, publisher, repository — the URL policy feeds on.
- **Europe PMC** is biomedical depth: PubMed abstracts, PMC full-text copies, preprints, and patents, with the OA flag and PMC URL reaching the agent — a biomedical query gets the readable body, not just the abstract page.
- **Semantic Scholar stays deferred:** it 429s in keyless testing — the free tier is unusable without a key. The extension now has a key store and a wizard skeleton, so reconsidering is one spec + thin instance away; the blocker is the provider's unusable free tier, not our plumbing.
- **Semantic recall is Exa's job, explicitly:** `provider: "exa"`, `category: "publication"` runs a dedicated academic index (~350M publications) that retrieves a specific paper from a fact, result, or half-remembered description — the known-item retrieval this vertical's keyword indexes are weakest at. It returns generic rows, so a hit resolves back through this vertical for the citeable record; no code integration, the schema wording carries the workflow.

## The identifier lookup

`filters.lookup` resolves one paper from a user-pasted link or a papers row's identifiers: web_fetching a doi.org link lands on the publisher's bot-walled redirect (the wall documented above), so the lookup goes through the API instead — `fetchRecord` on OpenAlex (`/works/{doi:…}`, the same call the backward walk's DOI seed makes) or an `EXT_ID`/`PMCID`/`DOI` query on Europe PMC. The identifier kind picks the backend — which is why `index` is ignored on lookups, and the other filters don't apply: a lookup retrieves, it doesn't constrain.

## The key + metering contract

OpenAlex meters per request: a `search=` query costs $0.001, a filter list $0.0001, and the anonymous budget is $0.10/day — roughly 100 searches before 429s bite. A free API key (openalex.org/settings/api) raises the budget 10×, sent as the `api_key=` query param on every works call (list, singleton, walk). Resolution precedence: config `papers.openalexApiKey` wins, env `OPENALEX_API_KEY` is the fallback, absent → keyless — the call must work without a key (smaller budget, not absent). `resolveOpenAlexKey` in `search/papers.ts` is the pure resolver; the adapter injects the key through deps, so tests stub it rather than touching config or env. The retired `mailto` politeness param appears nowhere: response headers are identical with and without it, and the ecosystem (pyalex, openalex-py) has migrated to keys.

The error contract reads the metering headers, not a probe: a 429 with zero remaining (`X-RateLimit-Remaining` / `X-RateLimit-Remaining-USD`) is *daily credits exhausted* — keyless callers are told the free key and `/openalex-setup` fix it, keyed callers get the countdown from `X-RateLimit-Reset` (seconds to midnight UTC); a 429 with remaining budget is *temporary throttling* (the >100 req/s limit) — retry shortly; 401/403 are *key rejected*. These are causes within the existing `backend-down` status, not new top-level statuses.

Lean payloads ride the same economy: every works-list call projects the shared `select=` list (`OPENALEX_SELECT` — exactly the fields normalization reads plus the enrichment fields), shrinking a full-record row ~4.5×. The DOI-seed record fetch is a free singleton and stays unprojected.

Setup is `/openalex-setup` — a thin instance of the shared key-setup wizard (`search/key-setup.ts`): free singleton-lookup validation, masked save, and a done screen that reads the real budget from `/rate-limit`. See the wizard section in [search-providers.md](search-providers.md).

## Citation-graph walks

- **OpenAlex is exact, both directions, one request each:** forward walk = `filter=cites:W…` (works citing the seed); backward = `filter=cited_by:W…` — the seed's own references, resolved server-side (verified live: 133 refs returned in one request where the forward filter on the same seed returned 8,092). The former chunked `referenced_works` hydration is gone — no OR-cap math survives. DOI seeds resolve through one free singleton record fetch first to get the W-id; W-id seeds go straight to the filter.
- **Europe PMC approximates:** its search query has no `CITES` field (verified, hitCount 0), so the walk runs its `/citations` (forward) and `/references` (backward) REST endpoints instead — the documented approximation. DOI seeds resolve through one search lookup first.
- Year constraints bind post-fetch on Europe PMC walks (`applyYearFilter` — the walk endpoints take no filter params); openAccess is dropped there, because walk entries carry no OA flag to verify. Acceptable: the walk is a discovery aid — the seed paper's own record is exact, and the agent can re-tighten with `index: "openalex"`.

## The citedBy sort

`filters.sort: "citedBy"` answers the "find papers on X which are highly cited" ask — relevance-ranked retrieval surfaces the pool, but the ordering the agent cites must be the citations'. OpenAlex sorts server-side (`sort=cited_by_count:desc`), so the ordering is exact. Europe PMC's search endpoint takes no sort field, so `applySort` ranks the fetched page post-fetch — a top-N of that page, not the index. Acceptable because relevance ranking already picked the pool: only the ordering of the fetched page is approximate, and the exact version is one `index: "openalex"` flip away.
