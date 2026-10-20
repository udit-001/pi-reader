# Papers vertical

Reference for `search/papers.ts`, `search/paper-backend.ts`, `search/europepmc.ts`. Param semantics live in the schema descriptions in `index.ts`; this doc carries the reasons and the live-verified wire facts.

## Shape

Two backends, one `PaperRecord`, one dispatch on `index`. The rule that makes that work is **absent-tolerance**: a key is present when its backend has it, never invented for the other one. Europe PMC supplies no entity ids and no `fwci`; that asymmetry forks nothing downstream because `normalize*` is the only backend branch — the entry and the shared helpers never ask which backend answered.

Badges order by consequence: `retracted` first, because a retraction reweighs every other token; then open access; then topic.

## One error grammar, three causes

`PaperError`'s message is the recovery path, passed through verbatim — the entry's generic error rewriter never touches it.

- **`malformed`** — the request was rejected, so the fix is in the query. OpenAlex returns 400 for a bad filter field, clause value, or cursor. Its complaint is quoted but bounded: an unknown field makes it enumerate every valid field, and that catalogue is not the actionable part. Europe PMC is worse — it returns no error at all for several faults, so the validator catches them before the wire, because a repaired query silently answers a question that was not asked. An `AUTHR:` typo drops to loose terms and returns nothing where `AUTH:` returns a full set; an unclosed quote loosens a phrase; an unclosed parenthesis turns an OR group into an AND set. Each names its fault and, where the repair changes meaning, what the repair does.
- **`backend-down`** — unreachable or metered. This is the cause that offers the retry `index` and the manual-DOI escape hatch, and its 429 slice reads the real budget rather than guessing: keyless exhaustion names the free key and `/openalex-setup`, keyed exhaustion gives the countdown from `X-RateLimit-Reset`, remaining budget reads as temporary throttling, 401/403 as a rejected key.
- **`no-results`** — the service answered and matched nothing. Offers the other index (different coverage may hold it), rephrasing, and the DOI path.

Whether a `malformed` message offers the other `index` follows one rule: only when that adapter could actually serve the request. A PMID handed to OpenAlex points across because the other index *is* the alternative; a rejected filter clause does not, because that syntax belongs to one adapter and pointing at the other is a circle.

## The keys a citation-aware pass needs

All OpenAlex-only, all absent-tolerant.

- **`fwci` beside `citedBy`** — raw count is absolute reach, `fwci` is breakout against the work's own topic+year+type cohort (1.0 = field-typical). Raw counts mislead across fields. The entry echoes a one-line glossary in band, data-gated, because a bare number tells the agent nothing mid-turn.
- **`refs` + `related` are the correlation atom.** Bare W-ids, capped, so the agent overlaps id sets across two rows locally and shared foundations surface with no extra calls. URLs are normalized to bare ids at the seam — the agent must never parse a URL to do id math. Unknown W-ids resolve through an identifier clause (`doi:…`, `ids.pmid:…`).
- **`recentCitations` + `citationTrend`** sum the last three *complete* years: the current year is always partial and would read as a crash. A 2012 paper still scoring 8k/year reads as active, not legacy.
- **`content`** is the abstract, capped at 300 chars and riding the inherited `content` key rather than a new one: the entry's preview branch already renders it, and 300 chars is cheap enough to include by default. The on-topic judgment is the one thing tokens cannot carry (verified live: the official OpenAlex MCP ships truncated abstracts in every list row).

The projection cost is accepted on a metering fact, not a bandwidth one: OpenAlex meters per request, not per byte, so the abstract's ~15 KB inverted index per row leaves the budget untouched and truncation keeps agent-facing tokens flat. If bandwidth ever matters, `abstract_inverted_index` is the single name to pull out.

**Retractions are excluded server-side, in each adapter's own filter**, rather than badged: a retraction disqualifies the work as a reading candidate. `filters.includeRetracted` drops the clause, and included rows carry the mark. The clause rides `filtersCacheKey` like every other filter. Its agent-facing home is the parameter's own description, because the consequence is a counting one: every count the interface sees is already net of retractions, so a short page is paging's doing.

## Authority and ids

- **`institutions` is a deduped set, not a per-author nesting.** The question the agent asks is "is this industry work?", which reads off the set; mapping authors to institutions would spend tokens answering a question nobody asked. A dual-affiliated author and a co-author at the same lab collapse to one entry, in authorship order.
- **`venue` carries a `type`** because the name cannot tell a bioRxiv row from a Nature one, and that is the difference between an unreviewed claim and an established one.
- **Every entity carries its OpenAlex id** because the filter language takes ids, not names — an id seen on one row is what makes "more from this lab" a one-call follow-up. `pmid`/`pmcid` bridge the same way, so an OpenAlex row can seed a Europe PMC walk.
- **`refCount` never follows the 40-id cap:** 451 references read as a bibliography, five as a footnote. Verified live to match the API's own count, so the second field is never requested.

## The expression door

`filters.expression` hands the API's own filter grammar to the agent, so constraints the named filters never anticipated arrive without new code, and a multi-seed citation walk becomes one request (`cites:W1|W2|W3`) instead of a plugin loop.

- **Validate structurally before editing.** An expression is comma-separated `field:value` clauses (a comma inside a quoted value does not split). Prose and OQL are declined in band, and the decline says what the free-text form does not get: the retraction clause merges into the filter form only.
- **Append, never rewrite.** The retraction clause goes on the end, and only when no `is_retracted` condition is present at either polarity — an agent asking *for* retracted works must not be contradicted. Clause order, spelling, and operators survive byte-for-byte. The expression rides `filtersCacheKey`; without that, a re-issued expression replays a cached page.
- **Refuse what the plugin also composes.** The expression *is* the filter list, so `year`/`yearRange`/`openAccess`/`citationGraph` alongside it are refused with the destination named. `sort`, `cursor`, `numResults`, `includeRetracted` stay orthogonal. This is the design, not a migration step: the two forms are one list.

The field catalogue itself is not copied into the description — it is the API's own list, so the description points at the live catalogue an unknown field returns. Merging one clause into text the plugin did not write is this door's only new logic, which is why it is pure.

**OQL stays a decline, not a second door.** Two doors meaning "filter these works" make the agent pick a path per call, when the condition separating them (rich boolean nesting, proximity) is narrow. The syntax would ride the always-loaded schema on every call, while a decline is paid only on the path that reaches it. And the merge rule cannot reach OQL, so serving it would stamp a retraction exemption on every row — the vertical's one safety guarantee, reprinted as a caveat. The decline answers with the translation (`works where year is (2020)` → `publication_year:2020`): the useful half of a second door without its cost. `group by` is told its shape is out of scope — this tool returns works, not counts.

## The row URL: most fetchable copy wins

Verified live: doi.org rate-limits per IP, so a walk over DOI links earns 429s, and the redirect lands on the most bot-walled corner of publishing while the PMC/DOAJ/repo copies fetch keylessly. So the row points at the most fetchable copy, ranked by one policy (`chooseFetchableUrl`) for both backends, and the bare DOI always rides `doi` — citation seeds and the `DOI:` meta line lose nothing.

One wire fact drives the adapters: OpenAlex's `landing_page_url` is usually the doi.org form, so the OpenAlex adapter reads `locations` for copies, and Europe PMC contributes its own ranked `fullTextUrlList`. That list is filtered rather than trusted, because "free" answers a licensing question while the ladder asks a readability one: a patent's copy is an Espacenet endpoint, and at the publisher tier it would outrank the record page that is the patent's only anchor. A skipped copy falls back to that anchor, so the filter's failure mode is a lost improvement, not a broken link. Europe PMC's synthesized PMC copy still holds the top tier, so a usable publisher copy improves records with no PMCID instead of displacing the full text.

## Two deliberate exclusions

**No degrade-to-text.** A text result is not a paper record: a row without year, venue, or DOI cannot be cited, and a web page masquerading as a paper poisons the citation work built on it. News degrades because a dated snippet legitimately answers a news query; papers cannot play that trick, so failure is in band with the recovery path, and a degraded papers response is never cached.

**Never in the auto chain.** The danger runs both ways: a web-intent query answered with scholarly metadata serves an abstract where the agent wanted a working page, and a scholarly-intent query answered with a web page throws away the citation graph. `index`/`filters` never hijack routing; the vertical reads its own params only.

## Why this backend pair

**OpenAlex is breadth** (~250M works, all disciplines, one endpoint, keyless with a small metered budget) and its `locations` list is what the URL policy feeds on. **Europe PMC is biomedical depth**: PubMed abstracts, PMC full text, preprints, patents, so a biomedical query gets the readable body rather than the abstract page. **Semantic Scholar stays deferred** because it 429s keyless — the blocker is the provider's free tier, not our plumbing; the wizard skeleton makes reconsidering one spec. **Semantic recall is Exa's job, explicitly:** `category: "publication"` retrieves a known item from a half-remembered description, the retrieval these keyword indexes are weakest at, and a hit resolves back through this vertical for the citeable record.

## The identifier constraint

A paper the agent can already name is a **constraint**, not a mode, so each adapter takes it in the constraint language it already reads, and an adapter that cannot read a syntax declines in band naming the form that works. The retired `lookup` mode is why: its one wire advantage was a free singleton fetch, and the constraint already returns a page of one. The singleton survives on the DOI-seeded walk alone, which needs the W-id before it can build a filter.

## Metering

OpenAlex meters per request: a `search=` query costs more than a filter list, and the anonymous daily budget is small enough that ~100 searches earn a 429. A free key raises it 10× and rides every works call. Precedence: config `papers.openalexApiKey`, then `OPENALEX_API_KEY`, then keyless — the call must work without a key, with a smaller budget rather than an absence. `resolveOpenAlexKey` is pure and the adapter takes it through deps, so tests stub it. The retired `mailto` param appears nowhere: response headers are identical with and without it, and pyalex and openalex-py have migrated to keys.

The error contract reads the metering headers, not a probe: zero remaining is *daily credits exhausted* (keyless → the free key; keyed → the `X-RateLimit-Reset` countdown), remaining budget is *temporary throttling*, 401/403 is *key rejected*. These are causes within `backend-down`, not new statuses.

## Citation walks

- **OpenAlex is exact, both directions, one request each:** `cites:W…` forward, `cited_by:W…` backward, both server-side (verified live: 133 refs in one request where the same seed's forward filter returned 8,092). The old chunked `referenced_works` hydration is gone. DOI seeds resolve through one free singleton fetch to get the W-id.
- **Europe PMC approximates:** its query language has no `CITES` field (verified, hitCount 0), so walks run `/citations` and `/references` — the documented approximation. Year binds post-fetch (the walk endpoints take no filter params), and `openAccess` is dropped because walk entries carry no OA flag to verify. Acceptable: the walk is a discovery aid, the seed's record is exact, and the agent can re-tighten with `index: "openalex"`.

## Paging: declared, never simulated

Each API pages its own way and the schema says which handle goes where. The live traps that decided it: Europe PMC's `/search` ignores `page` and returns page 1's identifiers with no error — a silent duplicate — so offset paging lives only on the walk routes; and above 1000 rows `/search` answers HTTP 200 with zero rows and no `hitCount`, which reads as "no results" rather than a rejected request. OpenAlex's nearer ceiling of 200 is its own 400, surfaced under `malformed` with the cap named.

The adapter passes the agent's handle through untouched and never follows it, so one call stays one request. The cursor rides `filtersCacheKey` (two pages must never share a key) and a cursor-bearing response is not cached: an enumeration step is not an answer, and a cached cursor can outlive its page. A rejected cursor reaches the agent as `malformed` with the backend's own complaint, so the fix stays local.

`idsOnly` asks for `resultType=idlist`; the seed a row hands back is then its identifier rather than its URL, so a MEDLINE or PMC row feeds a walk directly. Walk routes accept `resultType` and ignore it, which is why a walk declines the tier instead of passing full entries under a cheap-tier label. Page size rides `searchCacheKey`: 200 rows after a 10-row call is a different request.

## Europe PMC's query language

The accepted fields live in one table (`EUROPEPMC_OPERATORS`) that composes both the schema's listing and the validator's check, so a field cannot be documented and rejected at once — asserted in both directions by the tests. Two value traps it records: a PMID goes in `EXT_ID:22955618`-style form (`PMID:` is not a field), and a MeSH descriptor is quoted (`MESH:"Malaria"`).

- **`synonym=true` is opt-in** because the recall gain costs precision, and the trade is stated in the parameter's own description. The works adapter has no synonym table and declines it, naming the biomedical index.
- **`sort`** is the backend's own ordering (see below).

## Europe PMC's full record

The search asks for `resultType=core` because the authority signals live only there: per-author affiliations, the ORCID list, complete publication types, abstracts, evidence flags, MeSH headings with major-topic flags, compounds, funding, and ranked full-text copies. The lite default carried none of them, and one parser branch could never fire because of it — the venue read a block only the full record sends, so it fell through to the flat abbreviation. Core is a bandwidth cost, while the rendered row pays context only for what it prints:

- **Every row** pays the subject vocabulary and the authority block, because "is this on my topic" and "can I trust it" are asked of every result. MeSH headings print with majors first and marked; work type, preprint-versus-indexed source, the retraction marker with its notice, affiliations, and ORCIDs follow.
- **A single-record page** pays funding, compounds, language, status, evidence availability, and full-text copies — a list row pays per result, one record pays once.

A starred qualifier marks its descriptor major too: reading only the heading's own flag would file `Nanodiamonds/chemistry*` as incidental when the paper is centrally about nanodiamonds. This vocabulary is the curated counterpart of the algorithmic `topic`/`field` keys. One agency can appear several times because the backend lists a grant once per backing institute, and both are filterable server-side.

The wire's ORCID list is aggregate — Europe PMC links no identifier to a specific author — so the record carries the set rather than a per-author map the wire cannot support. The retraction notice is a `commentCorrection` of the "Retraction in" kind. Walk routes serve a compact entry shape and take no `resultType`, so these fields are the search record's.

## Ordering

The sort keys and the whole-set rule are the schema's; the mapping is `EUROPEPMC_SORTS` and OpenAlex's `sort=`. An unrecognised sort key never reaches the wire: Europe PMC answers one with HTTP 503, which would read as an outage. The walk routes accept `sort` and ignore it (verified live), so a walk's order comes from `applySort` over the fetched page — the last place the approximation survives.
