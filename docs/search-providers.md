# Search providers

Reference for `search/` and `config.ts`. Param semantics live in the schema descriptions in `index.ts`; this doc carries the routing policy and the wire traps the code cannot record.

## Routing

`autoChain()` is the routing seam: a pure function of intent params returning `[primary, failure-fallback]`. It runs behind `provider: "auto"`, the default. Pin every change in `test/routing.test.ts`.

- **Exa-shaped params** (`category`, `includeContent`, `includeSummary`, non-empty `domains`) route Exa-first with DDG fallback; anything else routes DDG-first with Exa fallback.
- **News intent** walks the fidelity ladder's first two rungs: Exa semantic news, and on an Exa *failure* the news vertical (dates and outlets), whose own degrade lands on text.
- **Fallback fires on provider failure, never on empty results** — an empty page is an answer. A degraded response carries `degraded: true`, and `shouldCacheSearch()` refuses it: pinning a fallen-back news query for the TTL would stop the ladder from ever recovering.
- **Free and explicit-only:** `wikipedia`, `hn`, `context7`, `news`, `images`. Never an auto primary, never in the fallback chain for non-news intent. When DDG and Exa both fail, `wikipedia`/`hn`/`context7` run as the last resort.
- **`parallel`** is free on the anonymous tier and explicit-only: the *second* index for a captcha-walled or thin DDG, not a silent third leg. One line in `autoChain()` if practice proves otherwise.
- **`openai`** (Codex) is explicit-only because it spends subscription quota; `auto` never spends money the agent did not ask for. Same rule, same cache refusal, as Exa.

## DuckDuckGo: the ddgs/uvx path

- **`uvx ddgs` is the primary** because it brings TLS fingerprinting and VQD handling for free — the reason the HTML path is the fallback and not the design.
- **Per-call output lands in a private dir** (`mkdtemp`, 0700): a world-readable guessable path lets a local user pre-place a symlink and feed fake results.
- **Warm-up is fire-and-forget,** once per process, and silent on failure because the HTML fallback covers search. The one exception: when warm-up *installs* uv, the user is told — `curl | sh` from astral.sh never runs invisibly.
- `REGENCY_TO_TIMELIMIT` is the single recency table for the ddgs adapter, the HTML adapter, and news; `page` and `domains` map through the same plan.

## Verticals: what is policy, not plumbing

**News.** Normalization invents nothing — the source's own date string passes through unmodified, including junk like `"Opinion2 days ago"`; a cleaned-up date would be a claim the backend never made. `domains` is stripped before the shared seam because the news engines do not support it. Degrade lands on text, and the provider label then reports `duckduckgo`: a degraded answer must not masquerade as news.

**Images.** The row points at the direct origin, never the thumbnail or the source page — the agent's verb is embed or vision-check, and both need the image. No degrade-to-text: text cannot substitute for an image, so failure is an in-band error rather than plausible-looking results. `license` is a request-time filter, and `"any"` emits no flag (the server default). The engines reject ddgs `-t` outright (`KeyError` on every backend, verified live against a `--help` that advertises it), so the images path drops timelimit and the schema marks `recency` unsupported.

**Videos.** The one vertical that bypasses ddgs: ddgs's only backend here uses an HTTP client (`primp`, TLS-spoofed) that `v.js` 403-bans, while the endpoint accepts a plain browser-UA fetch (verified live). The row points at the watch URL, since the agent acts on the video rather than a page about it. No retries on 403 — a fingerprint ban is not retry-recoverable, and the plain-UA client exists to avoid earning one. The fragile seam is the VQD token regex (pinned by a markup fixture); its failure names the text-search-plus-`domains: ["youtube.com"]` workaround.

## Papers

Two backends behind one dispatch, one record shape, failure always in band. The reasons are in [papers.md](papers.md).

## Codex web search

- **No API key:** auth resolves through `ctx.modelRegistry` (`openai-codex`, then `openai` with ChatGPT OAuth), so this rides the subscription Pi already holds. No credential → `OpenAISearchUnavailableError` whose message is the recovery path, passed through verbatim.
- **Search is model-mediated:** the model writes the queries and the answer. This is the only provider whose `answer` is model prose rather than `buildAnswer(results)` — which means a sparse answer is the model's doing, not a ranking bug.
- **The Codex endpoint sends `response.completed` with an empty `output`,** so the parse seam collects `output_item.done` items and trusts the completed payload only when non-empty. Default model is the newest `luna`-tier Codex model (then `terra`, then the newest versioned id); `pro`/`ultra` are excluded as disproportionate to a search call.

## Exa MCP

- **Key precedence:** `~/.pi/agent/pi-reader.json` (`exa.apiKey`), then `EXA_API_KEY`. `mcp.json` is a wizard *import source*, never a runtime key source — a stale entry there must not shadow a key the user saved later. Resolution is lazy and cached; `resetExaKeyCache()` after a wizard write makes a new key live without a restart.
- **`redactSecret()` (`search/redact.ts`)**, shared with Codex, wraps every error leaving the adapter, so a key never reaches the transcript. Short values are skipped because they occur in ordinary text.

## Parallel MCP

- **Anonymous is the product, not a degraded state.** No key → free tier (fast mode). A key raises limits and rides the `Authorization` header through `connectMcp`'s `authToken`, never the URL, so it cannot leak into transport errors — the one call-site difference from Exa's keyed-URL composition.
- **One `session_id` UUID per process,** generated lazily: the server buckets free-tier limits to it, and a fresh id per call would reset the shared budget.
- **The query goes verbatim as both `objective` and `search_queries[]`:** pi-reader has no richer intent, and a paraphrase would lose the agent's wording.
- **`null` (anonymous) is a valid key resolution,** so there is no missing-key state — only rate limiting, in the same once-per-call hint grammar as Exa.
- An invalid key 401s at call time (verified live), which is what makes wizard validation honest rather than optimistic.
- Cached like DDG, not a `QUOTA_PROVIDERS` member: the free tier costs nothing, and caching a keyed search saves the paid one.

## Config

Non-obvious keys: `parallel.apiKey` absent is a valid state; `hints.mcpDuplicate` persists a one-time explanation; `openai.searchModel` is sent verbatim.

## Setup

One command, `/search-setup`, opens a provider menu (Exa, Parallel, OpenAlex) that hosts each provider's wizard in one overlay: pick a row, the wizard runs inside it, done returns to the menu with statuses re-read. `/search-setup exa` (also `parallel`, `openalex`) preselects the row; this arg is how the rate-limit prompts route recovery. All setup surfaces share one guard, so only one is open at a time. The per-provider commands are gone; every hint string names `/search-setup <provider>`.

## Wizards

One skeleton owns the flow, the spinner, redaction, and the headless manual-path fallback, and the reopen guard is shared with the menu (one surface at a time); each provider is a spec plus a thin subclass. Two rules live outside the skeleton because one provider owns them: the `mcp.json` import and duplicate removal belong to the Exa instance, and the duplicate warning fires once per install (persisted) then drops to a brief reminder while the condition persists — an Exa `directTools` entry otherwise puts raw Exa tools beside `web_search` in every session. A wizard runs only inside the /search-setup overlay: it needs keyboard focus, so headless prints the manual paths instead.
