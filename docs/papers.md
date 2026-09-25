# Papers vertical

Reference for `search/papers.ts` (backend dispatch), `search/paper-backend.ts` (shared record seam), and `search/europepmc.ts` (Europe PMC backend). Open before touching the papers vertical, scholarly search, citation traversal, or paper-record normalization. Param semantics live in the schema descriptions in `index.ts`; this doc carries the reasons behind the choices.

## Shape

- `provider: "papers"` → `searchPapers()`: the backend dispatcher. `index` picks the backend — `"openalex"` (default) or `"europepmc"` — and both normalize into the one `PaperRecord` shape (`year`, `authors`, `venue`, `citedBy`, `oaUrl`, `doi` flat keys beside the standard `title`/`url`/`snippet`). `search/paper-backend.ts` owns the record, the snippet builder, the URL policy, and the error contract; `normalize*` is the only backend fork point, so downstream (entry rendering, the filters) never branches on the backend.
- Failure throws `PaperError`, whose message is built by `paperError()` — the entry passes it verbatim. Three statuses: `no-results`, `backend-down`, `malformed`, each naming the backend, the retry `index`, and a manual-DOI escape hatch. The entry's generic error rewriter never touches these — the retry hint IS the actionability.

## The record URL: most fetchable copy wins

Each row's `url` is the canonical place the agent acts on — the link a human clicks and the fetch chain resolves. Both backends rank their candidates through `chooseFetchableUrl` in `search/paper-backend.ts` — one URL policy for the vertical, the rank ladder in its comment. The row points at the most fetchable copy the work carries; the bare DOI always rides the `doi` key, so citation seeds and the `DOI:` meta line lose nothing when the URL is a copy, and a closed work with no copy anywhere keeps the doi.org link.

The ordering is the point — verified live: doi.org rate-limits per IP, so 429s bite when an agent walks a result set of DOI links, and the redirect lands on the most bot-walled corner of publishing (Cloudflare challenges, auth transit pages) while the PMC/DOAJ/repo copies fetch keylessly. One wire fact drives the adapters: OpenAlex's own `landing_page_url` is usually the doi.org form, so the OpenAlex adapter reads `locations` for the copies, and Europe PMC ranks its PMC copy over its DOI.

## Why in-band failure, not degrade-to-text

A text-search result is not a paper record — no substitutes exist. The news vertical degrades to text because a dated snippet legitimately answers a news query; papers can't play that trick: a row without year/venue/DOI cannot be cited, and a web page masquerading as a paper would poison the citation work the agent builds on it. So every papers failure surfaces as an in-band error with the recovery path, and `shouldCacheSearch()`'s degraded-flag refusal holds for papers too — a degraded papers response is never cached under the papers key.

## Why explicit-only, outside the auto chain

`provider: "papers"` is never chosen by `autoChain()` — not as primary, not as fallback (pinned in the routing tests). The danger runs both directions: a broad web-intent query silently answered with scholarly metadata serves an abstract when the agent wanted a working page; a scholarly-intent query answered with a web page throws away the citation graph. A deliberate dispatch keeps both semantics visible, and `index`/`filters` never hijack routing — the papers vertical reads its own params only.

## Why OpenAlex + Europe PMC

- **OpenAlex** is breadth: ~250M works across all disciplines, keyless, one JSON endpoint. Its metadata is the universal index, and its `locations` list carries every copy — PMC, DOAJ, publisher, repository — the URL policy feeds on.
- **Europe PMC** is biomedical depth: PubMed abstracts, PMC full-text copies, preprints, and patents, with the OA flag and PMC URL reaching the agent — a biomedical query gets the readable body, not just the abstract page.
- **Semantic Scholar stays deferred:** it 429s in keyless testing — the free tier is unusable without a key. Reconsider when a keyless quota appears or the extension gains a key store it can trust.
- **Semantic recall is Exa's job, explicitly:** `provider: "exa"`, `category: "publication"` runs a dedicated academic index (~350M publications) that retrieves a specific paper from a fact, result, or half-remembered description — the known-item retrieval this vertical's keyword indexes are weakest at. It returns generic rows, so a hit resolves back through this vertical for the citeable record; no code integration, the schema wording carries the workflow.

## The mailto politeness contract

OpenAlex rate-limits by contact address: without one, you share the 10k/day anonymous pool (403s bite early); with `papers.openalexEmail` set, the limit rises to the credited 100k/day. The address is optional-but-recommended in the config file, and the call is absent-tolerant by contract — it must work without it. `readMailto()` in `search/papers.ts` is the single home for the read; tests inject the address via deps, never through the config file.

## Citation-graph approximation

- **OpenAlex is exact:** forward walk = `filter=cites:W…`; backward = the seed record's `referenced_works` hydrated through `filter=openalex_id:W…|…` OR-lists, chunked at the API's 50-value cap. There is no server-side "works this paper cites" filter — `referenced_works:W…` auto-maps onto the forward direction (verified live), so the backward leg must hydrate.
- **Europe PMC approximates:** its search query has no `CITES` field (verified, hitCount 0), so the walk runs its `/citations` (forward) and `/references` (backward) REST endpoints instead — the documented approximation. DOI seeds resolve through one search lookup first.
- Year constraints bind post-fetch on Europe PMC walks (`applyYearFilter` — the walk endpoints take no filter params); openAccess is dropped there, because walk entries carry no OA flag to verify. Acceptable: the walk is a discovery aid — the seed paper's own record is exact, and the agent can re-tighten with `index: "openalex"`.

## The citedBy sort

`filters.sort: "citedBy"` answers the "find papers on X which are highly cited" ask — relevance-ranked retrieval surfaces the pool, but the ordering the agent cites must be the citations'. OpenAlex sorts server-side (`sort=cited_by_count:desc`), so the ordering is exact. Europe PMC's search endpoint takes no sort field, so `applySort` ranks the fetched page post-fetch — a top-N of that page, not the index. Acceptable by the same logic as the walk filters.
