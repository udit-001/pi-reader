// pi-reader — web search (DuckDuckGo + Exa MCP) and URL→Markdown
// fetch for the Pi coding agent. Zero config: reads the Exa MCP key from the
// same ~/.pi/agent/mcp.json pi uses; DuckDuckGo needs no key at all.
//
// Tools:
//   web_search — search the web. provider: "auto" (DuckDuckGo → Exa MCP
//     fallback), "duckduckgo", "exa", or "news" (ddgs news vertical — dated,
//     outlet-attributed). Exa supports category filters, domains, recency,
//     and full content/summary extraction via the web_search_advanced_exa
//     tool on the remote MCP.
//   web_fetch — fetch URL(s) as clean Markdown. Structured handlers render
//     known sites directly (GitHub/GitLab repos: metadata+README, releases,
//     issues/PRs, raw files; package registries; Wikipedia, HN, Reddit,
//     Stack Exchange, arXiv); everything else falls through the free remote
//     fallback chain (Jina, markdown.new) to Exa MCP. Optional: answer a
//     prompt about the pages using the current pi model.
//
// Shape: thin entry. The depth lives in search.ts (provider seam + result
// normalization) and fetch.ts (content-type sniffing + conversion).

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { consumeExaIssue } from "./search/exa-issue.ts";
import { warmDdgs } from "./search/ddgs-uv.ts";
import { exaCategoryList } from "./search/exa-mcp.ts";
import { detectMcpDuplicate } from "./search/exa-setup.ts";
import { consumeParallelIssue } from "./search/parallel-mcp.ts";
import { registerSearchSetupCommand } from "./search/setup-menu.ts";
import { webCrawlRenderers, webFetchRenderers, webSearchRenderers, type CrawlDetails, type FetchDetails, type WebSearchDetails } from "./render.ts";
import { crawl, excerptOf } from "./fetch/crawl.ts";
import { configPath, loadConfig, saveConfig } from "./config.ts";
import { webSearch, type SearchProviderName } from "./search/search.ts";
import { OpenAISearchUnavailableError } from "./search/openai.ts";
import { isPaperRecord, renderPaperExtras, PAPER_SEARCH_MODES, PAPER_SORTS, PaperError, type PaperRecord } from "./search/paper-backend.ts";
import { EUROPEPMC_OPERATOR_LISTING, EUROPEPMC_PAGE_SIZE_MAX } from "./search/europepmc.ts";
import { EXPRESSION_PARAM_DESCRIPTION, OPENALEX_CITATION_EDGES } from "./search/papers.ts";
import { fetchContent, summarizeContent, type FetchResult } from "./fetch/fetch.ts";

/** The citation-edge vocabulary as agent-facing prose, composed from the one
 *  list that holds it so the description and the in-band note cannot drift from
 *  the tokens the adapter forwards (PIWEB-31). */
const CITATION_EDGE_PROSE = OPENALEX_CITATION_EDGES
  .map((e) => `'${e.token}:W…' (${e.meaning})`)
  .join(" / ");

/** The ordering vocabulary as agent-facing prose, composed from the one table
 *  that holds it so the description cannot name a key the adapters do not
 *  forward, or omit one they do (PIWEB-24). */
const SORT_PROSE = PAPER_SORTS
  .map((s) => `'${s.key}' (${s.condition})`)
  .join(", ");

/** The matcher vocabulary as agent-facing prose, composed from the one table
 *  that holds it so the description cannot name a key the adapters do not
 *  forward, or omit one they do. The default — the stemmed keyword search — is
 *  named in the sentence, not the table: it is the absence of the parameter. */
const SEARCH_MODE_PROSE = PAPER_SEARCH_MODES
  .map((m) => `'${m.key}' (${m.condition})`)
  .join(", ");

// ── Schemas ──────────────────────────────────────────────────────────────────

const providerSchema = Type.Optional(
  Type.Union(
    [
      Type.Literal("auto"),
      Type.Literal("duckduckgo"),
      Type.Literal("exa"),
      Type.Literal("parallel"),
      Type.Literal("openai"),
      Type.Literal("news"),
      Type.Literal("images"),
      Type.Literal("videos"),
      Type.Literal("papers"),
      Type.Literal("wikipedia"),
      Type.Literal("hn"),
      Type.Literal("context7"),
    ],
    {
      description:
        "Which provider to search. 'auto' (default) runs DuckDuckGo, then Exa on failure; any " +
        "Exa-shaped param (category, includeContent, includeSummary, domains) starts at Exa. " +
        "Name a provider when you know the need:\n" +
        "• 'context7' — API reference for a named library or SDK: exact endpoints, function " +
        "signatures, and config options, served as versioned plaintext docs. Reach for it when " +
        "integrating or calling a library and its docs are not already in context; fetch the " +
        "returned URL for the full reference.\n" +
        "• 'news' — news coverage ('what happened this week about X'): dated, outlet-attributed " +
        "articles from free keyword engines; honors query, recency (d/w/m/y), and page; no " +
        "domains; degrades to text search with a visible notice. category: 'news' instead uses " +
        "Exa semantic news (better relevance, uses quota).\n" +
        "• 'wikipedia' — factual 'what is X'. 'hn' — Hacker News discussions.\n" +
        "• 'parallel' — a second independent keyword index (free to try): cross-index " +
        "coverage in research passes, deep reads where its long inline excerpts save " +
        "fetches, or when DuckDuckGo is captcha-walled or thin. Its index lags breaking " +
        "news — recency belongs to 'news' or recency-flagged 'auto'. Ignores Exa-shaped " +
        "params (category, domains, recency, includeContent).\n" +
        "• 'openai' — a grounded, cited answer from your ChatGPT/Codex subscription (no key): " +
        "for 'what changed in X' or 'is Y still true' — phrase the query as the question. " +
        "Costs subscription quota and takes a few seconds; plain page-finding belongs to 'auto'.\n" +
        "• 'images' — image discovery ('find a photo of X'): the result URL is the hotlinkable " +
        "image itself, with dimensions and source in the snippet; honors query, page, and license.\n" +
        "• 'videos' — video discovery ('find a video about X'): watch URLs with duration, views, " +
        "uploader, and date; honors query, recency (d/w/m/y), and page. When unavailable, fall " +
        "back to text search with domains: ['youtube.com'].\n" +
        "• 'papers' — scholarly literature: citeable records for a literature pass. " +
        "Find on a topic: the free-text query (the default). Walk citations from a " +
        "paper you already hold: filters.citationGraph, for when the top hits missed " +
        "the topic or the years, or you want the foundations under a hit. Look up one " +
        "known paper by its identifier: filters.expression. Its backend is chosen by " +
        "`index`: 'openalex' (default, all disciplines) or 'europepmc' (biomedical — " +
        "PubMed, Europe PMC); a biomedical ask is provider: 'papers' with index: " +
        "'europepmc'.",
    },
  ),
);

const paperIndexSchema = Type.Optional(
  Type.Union([Type.Literal("openalex"), Type.Literal("europepmc")], {
    description:
      "Papers provider only: which backend to query. 'openalex' (default) — open " +
      "scholarly metadata across all disciplines; its `query` takes boolean " +
      "`AND`/`OR`/`NOT`, quoted phrases, and `~N` for proximity or fuzzy matching. " +
      "'europepmc' — biomedical full text: PubMed, PMC copies, preprints, patents. " +
      "Its `query` is Europe PMC's own field language, written TOKEN:value: " + EUROPEPMC_OPERATOR_LISTING + ".",
  }),
);

const paperFiltersSchema = Type.Optional(
  Type.Object(
    {
      year: Type.Optional(Type.Integer({
        description: "Restrict to this publication year.",
      })),
      yearRange: Type.Optional(Type.Array(Type.Integer(), {
        minItems: 2,
        maxItems: 2,
        description: "Inclusive [from, to] publication years.",
      })),
      openAccess: Type.Optional(Type.Boolean({
        description: "Restrict to open-access-readable results.",
      })),
      includeRetracted: Type.Optional(Type.Boolean({
        description: "Papers provider only: include retracted works. They are excluded by default — a retraction disqualifies the work as a reading candidate; when included, the retracted key marks them.",
      })),
      sort: Type.Optional(Type.Union([Type.Literal("citedBy"), Type.Literal("date"), Type.Literal("fwci")], {
        description: "Rank by " + SORT_PROSE + ". Relevance is the default; ranking replaces it, so give it a subject to rank: add a filter in the same call (filters.expression: \"title.search:…\") when the query is a word or two. Both adapters sort the whole set at the backend; a Europe PMC citation walk is the one exception, its routes taking no sort. 'fwci' is OpenAlex's alone — Europe PMC computes no field-normalized impact and declines it in band.",
      })),
      searchMode: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("semantic")], {
        description: "Papers provider only: pick a matcher other than the default stemmed keyword search — " + SEARCH_MODE_PROSE + ". OpenAlex only; Europe PMC declines it.",
      })),
      synonym: Type.Optional(Type.Boolean({
        description: "Europe PMC only: expand the query through the backend's synonym table — 'heart attack' also reaches 'myocardial infarction'. Recall leaps (54,785 → 755,190 on a quoted phrase) at a precision cost, so reach for it when recall is what this turn needs. OpenAlex declines it in band (the lever is Europe PMC's), and so does a Europe PMC citation walk, having no query to expand — run a search instead.",
      })),
      idsOnly: Type.Optional(Type.Boolean({
        description: "Europe PMC only: the identifiers-only tier — the cheap way to enumerate a large set, each match its source-scoped identifiers. Composes with filters.cursor; a citation walk and the OpenAlex adapter decline it.",
      })),
      cursor: Type.Optional(Type.String({
        description: "Papers provider only: continue an enumeration with the handle the last response returned — pass '*' to open one, then each response's Next cursor, unmodified, until it stops coming (e.g. a long reference or citation list). OpenAlex's works endpoint and Europe PMC's search both page this way; a Europe PMC /references or /citations walk declines the cursor in band — pass `page` there. One call fetches one page: the cursor is never followed automatically.",
      })),
      expression: Type.Optional(Type.String({
        description: EXPRESSION_PARAM_DESCRIPTION,
      })),
      citationGraph: Type.Optional(
        Type.Object(
          {
            seed: Type.String({
              description: "The paper the citation edges start from — a DOI (10.…), PMID, PMCID, or OpenAlex W-id; anything a prior papers row handed you.",
            }),
            direction: Type.Optional(Type.Union(
              [Type.Literal("cites"), Type.Literal("citedBy")],
              {
                description:
                  "'cites' (default) — `cites:W…`: works that cite this paper. 'citedBy' — " +
                  "`cited_by:W…`: this paper's own references. The works adapter composes " +
                  "year/openAccess server-side; Europe PMC serves the same edges through its " +
                  "/citations and /references endpoints, where year binds post-fetch and " +
                  "openAccess is dropped.",
              },
            )),
          },
          {
            description:
              "Traverse from one paper; replaces the free-text query (query may be " +
              "empty when this drives the search).",
          },
        ),
      ),
    },
    {
      description:
        "Papers provider only: extra controls on a papers search. Other providers " +
        "ignore it — each field is read only by the adapter that can serve it.",
    },
  ),
);

const licenseSchema = Type.Optional(
  Type.Union(
    [Type.Literal("any"), Type.Literal("share"), Type.Literal("commercial"), Type.Literal("modify")],
    {
      description:
        "License filter, images provider only (request-time on the search engine). " +
        "'share' for shareable, 'commercial' for commercial use, 'modify' for modifiable; " +
        "'any' is the default. When an image will be embedded in a deliverable, filter " +
        "here rather than vetting each result's license by hand.",
    },
  ),
);

const recencySchema = Type.Optional(
  Type.Union(
    [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
    { description: "Only results published within this window. DuckDuckGo, the news vertical, the videos vertical, and Exa honor it (DDG filters at the source, no dates shown; news, videos, and Exa show dates); images does not support it; other providers ignore it" },
  ),
);

const domainSchema = Type.Optional(
  Type.Array(Type.String(), {
    description: "Restrict to domains (prefix with - to exclude, e.g. ['github.com', '-reddit.com']). Honored by duckduckgo, exa, and openai; other providers ignore it",
  }),
);

const webSearchParams = Type.Object({
  query: Type.String({
    description: "Phrase the query as the page you want to land on (e.g. 'stripe API charge endpoint'). For 'openai', phrase it as the question you want answered (e.g. 'is Stripe's charge API deprecated').",
  }),
  provider: providerSchema,
  numResults: Type.Optional(Type.Integer({
    minimum: 1,
    // Europe PMC's own per-page ceiling, and the strictest one that answers a
    // silent empty above it (HTTP 200, zero rows, no hitCount). Holding the
    // tool's ceiling to it means that case cannot be sent at all. OpenAlex's
    // nearer 200 is the API's own 400, which names the cap.
    maximum: EUROPEPMC_PAGE_SIZE_MAX,
    description: "Results per page. Default: 10 with category, 15 without. A papers enumeration can ask for many — OpenAlex serves up to 200 rows per page and Europe PMC up to 1000; the web engines return what they have.",
  })),
  page: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 50,
    description: "Result page to fetch (1 = top results; 2 with numResults 10 = results 11–20). Honored on duckduckgo, news, images, videos, and Europe PMC's /references and /citations walks, whose entries are offset-paged. Papers enumeration pages by cursor (filters.cursor) instead, so the works adapter and a Europe PMC search both decline `page` in band. Other providers ignore it.",
  })),
  recency: recencySchema,
  license: licenseSchema,
  index: paperIndexSchema,
  filters: paperFiltersSchema,
  domains: domainSchema,
  category: Type.Optional(Type.Union(
    exaCategoryList().map((c) => Type.Literal(c)) as [ReturnType<typeof Type.Literal<string>>, ...ReturnType<typeof Type.Literal<string>>[]],
    {
      description:
        "Filter by content type. Use 'company' for company/funding data, " +
        "'people' for LinkedIn/professional profiles, 'news' for recent events — " +
        "Exa semantic news; under auto an Exa failure falls to the free news " +
        "vertical (keyword, dated) before generic text. " +
        "'publication' — semantic search over Exa's academic publication index: retrieves " +
        "a specific paper from a fact, result, or half-remembered description ('the paper " +
        "where …'); returns generic rows — pair a hit with provider: 'papers' for its " +
        "citeable record. Under auto an Exa failure falls to plain text search, the " +
        "category dropped. 'github' for code/repos.",
    },
  )),
  includeContent: Type.Optional(Type.Boolean({
    description: "Exa: include full page text for each result (up to 50k chars each)",
  })),
  includeSummary: Type.Optional(Type.Boolean({
    description: "Exa: generate an AI summary for each result",
  })),
});

const webFetchParams = Type.Object({
  urls: Type.Union(
    [
      Type.String({ description: "URL to fetch as Markdown" }),
      Type.Array(Type.String(), { description: "Multiple URLs to fetch in parallel" }),
    ],
    { description: "URL(s) to fetch. Pass a plain string, not a JSON-encoded array." },
  ),
  maxChars: Type.Optional(Type.Integer({
    minimum: 500,
    maximum: 100_000,
    description: "Max characters per page (default: 20000)",
  })),
  mode: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("raw")], {
    description:
      "Response format. 'markdown' (default) extracts readable content. " +
      "'raw' returns the exact response body — HTML/XML/JSON with a status and content-type label — " +
      "for metadata inspection, structured data in pages, or debugging extraction. " +
      "On sites whose public URL is an app shell, raw serves the site's canonical API body; " +
      "read those sites with markdown.",
  })),
  prompt: Type.Optional(Type.String({
    description: "If set, answer this prompt about the page(s) using the current pi model",
  })),
  topic: Type.Optional(Type.String({
    description: "Extract sections matching this topic instead of returning full content",
  })),
  model: Type.Optional(Type.String({
    description: "Override for the summarizing model (provider/model-id). Requires prompt.",
  })),
});

type WebSearchParams = Static<typeof webSearchParams>;
type WebFetchParams = Static<typeof webFetchParams>;

// ── Extension entry ──────────────────────────────────────────────────────────

// The adapter notes rate-limit/missing-key issues as they happen, even when
// callers auto-fallback and swallow the error. This surfaces them once, with
// the recovery path — the menu never auto-opens over a running session. All
// providers recover through /search-setup <provider>; the arg preselects the
// row (see setup-menu.ts, the openers' one door).
function notifyExaIssueOnce(ctx: ExtensionContext): void {
  const issue = consumeExaIssue();
  if (!issue) return;
  if (issue === "rate-limited") {
    ctx.ui.notify("Exa is rate limited. Run /search-setup exa to replace the key — DuckDuckGo still works.", "warning");
  } else {
    ctx.ui.notify("No Exa API key configured. Run /search-setup exa to add one — DuckDuckGo still works.", "warning");
  }
}

// Parallel's only failure state is rate-limiting (anonymous is a valid
// configuration, so there is no missing-key hint). Same once-per-session
// surfacing as Exa's.
function notifyParallelIssueOnce(ctx: ExtensionContext): void {
  if (!consumeParallelIssue()) return;
  ctx.ui.notify("Parallel is rate limited. Run /search-setup parallel to add a key for higher limits — DuckDuckGo still works.", "warning");
}

export default function piWeb(pi: ExtensionAPI): void {
  registerSearchSetupCommand(pi);

  // Duplication hygiene: an mcp.json exa entry with directTools puts exa's
  // raw tools next to web_search/web_fetch in every session. The detailed
  // explanation fires once per user (persisted flag in our config); while the
  // condition persists, later sessions get one brief reminder at start. Both
  // self-heal the moment the entry is removed.
  pi.on("session_start", (_event, ctx) => {
    // Warm the ddgs path in the background: moves the one-time uv/ddgs
    // download off the first search. Fire-and-forget; failure is silent —
    // search falls back to HTML scraping as before. The install itself is
    // `curl | sh` from astral.sh — never silent: the user is told it ran.
    void warmDdgs(undefined, () =>
      ctx.ui.notify(
        "Installed uv for DuckDuckGo search. Source: the astral.sh installer (curl | sh). Uninstall uv to fall back to HTML scraping.",
        "info",
      ));

    if (!detectMcpDuplicate()) return;
    const config = loadConfig() ?? { version: 1 };
    if (config.hints?.mcpDuplicate) {
      ctx.ui.notify("Exa configured in both mcp.json and pi-reader — /search-setup to dedupe", "info");
      return;
    }
    ctx.ui.notify(
      "Exa is configured in mcp.json, and pi-reader's web_search/web_fetch already cover it. " +
        "Run /search-setup to import the key and remove the duplicate.",
      "warning",
    );
    saveConfig(configPath(), {
      ...config,
      version: 1,
      hints: { ...config.hints, mcpDuplicate: new Date().toISOString() },
    });
  });

  pi.registerTool({
    name: "web_search",
    label: "search",
    description:
      "Search the web. 'auto' (default) runs DuckDuckGo, then Exa; Exa-shaped params " +
      "(category, includeContent, includeSummary, domains) start at Exa. Name a provider when " +
      "you know the need — 'context7' for API reference (a named library or SDK's endpoints, " +
      "signatures, and config), 'wikipedia' for facts, 'hn' for Hacker News discussions, " +
      "'news' for dated coverage, 'images' and 'videos' for media discovery, " +
      "'openai' for a grounded, cited answer, 'papers' for scholarly paper records. " +
      "Phrase the query as the page you want to land on (e.g. 'stripe API charge endpoint').",
    promptSnippet: "Search the web; provider 'context7' returns library/API reference docs (endpoints, signatures); 'papers' returns citeable scholarly records (find papers on X).",
    parameters: webSearchParams,
    ...webSearchRenderers,
    async execute(
      _callId: string,
      params: WebSearchParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebSearchDetails>> {
      // Hoisted out of `try` so the catch block can name the requested
      // provider in its recovery message (parallel's rate limit has a
      // different fix than Exa's).
      const provider = (params.provider ?? "auto") as "auto" | SearchProviderName;
      // Mid-run feedback: the transcript holds this line (renderResult's
      // isPartial branch) until the real result lands, so a slow provider
      // doesn't read as a dead call. The index is named only when the agent
      // picked it — on 'auto' a fallback could answer instead, and the line
      // must not go stale mid-flight. Empty details: partials are rendered
      // from content alone until the final result carries the real payload.
      const where = provider !== "auto" ? ` ${provider}` : "";
      onUpdate?.({
        content: [{ type: "text", text: `Searching${where} for “${params.query}”…` }],
        details: {},
      });
      try {
        // Smart default: category present → precise (10), broad discovery → 15
        const numResults = params.numResults ?? (params.category ? 10 : 15);
        const response = await webSearch(params.query, {
          provider,
          numResults,
          recency: params.recency,
          domains: params.domains,
          page: params.page,
          license: params.license,
          category: params.category as "company" | "publication" | "news" | "personal site" | "people" | "pdf" | "github" | "financial report" | undefined,
          includeContent: params.includeContent,
          includeSummary: params.includeSummary,
          index: params.index,
          filters: params.filters,
          extensionContext: ctx,
          signal,
        });

        const pageLabel = params.page && params.page > 1 ? ` · page ${params.page}` : "";
        // The index's own count, printed only when it exceeds the rows: a page
        // that is the whole set needs no count (the rows are it), while a short
        // one is legible as a page rather than as the whole literature. The
        // number is the index's, post-filter — a server-side exclusion never
        // shows up here as a gap.
        const totalLabel = response.total !== undefined && response.total > response.results.length
          ? ` · showing ${response.results.length} of ${response.total.toLocaleString("en-US")}`
          : "";
        const lines = [`Provider: ${response.provider}${pageLabel}${totalLabel}`];
        // Papers envelope: in-band field glossary + audit trail. Data-gated —
        // a note only fires when the resultset actually carries the feature,
        // so Europe PMC pages don't read a glossary for keys they never have.
        if (response.provider === "papers") {
          const rows = response.results as PaperRecord[];
          if (rows.some((r) => r.fwci !== undefined)) {
            lines.push(`fwci = citations ÷ field-typical (1.0 = expected for the paper's topic+year+type; raw Cited by = absolute reach, fwci = breakout against its own cohort).`);
          }
          if (rows.some((r) => r.refs?.length)) {
            lines.push(`Refs/Related are bare OpenAlex W-ids (refs capped at 40); any of them seeds a citation query — filters.expression: ${CITATION_EDGE_PROSE}.`);
          }
        }
        lines.push("", response.answer, "", "Results:");
        const singleRecord = response.results.length === 1;
        for (let i = 0; i < response.results.length; i++) {
          const r = response.results[i]!;
          const hasContent = typeof r.content === "string" && r.content;
          lines.push(`${i + 1}. ${r.title || "(untitled)"}`);
          lines.push(`   ${r.url}`);
          if (r.publishedDate) lines.push(`   Published: ${r.publishedDate}`);
          if (r.author) lines.push(`   By: ${r.author}`);
          if (isPaperRecord(r)) {
            lines.push(...renderPaperExtras(r, singleRecord));
          }
          if (hasContent) lines.push(`   ${r.content!.replace(/\s+/g, " ").trim().slice(0, 400)}`);
        }
        if (response.nextCursor) {
          lines.push("", `Next cursor: ${response.nextCursor} — pass as filters.cursor for the next page.`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            provider: response.provider,
            resultCount: response.results.length,
            ...(params.category ? { category: params.category } : {}),
            ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
            // Only openai's answer is model-authored prose; every other
            // provider's is buildAnswer(rows) — a view of the rows below,
            // not a fact worth its own surface presence.
            ...(response.provider === "openai" && response.answer
              ? { answer: response.answer }
              : {}),
            results: response.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.snippet.slice(0, 500),
              ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
              ...(r.author ? { author: r.author } : {}),
              ...(isPaperRecord(r)
                ? {
                  ...(r.year !== undefined ? { year: r.year } : {}),
                  ...(r.venue ? { venue: r.venue } : {}),
                  ...(r.citedBy !== undefined ? { citedBy: r.citedBy } : {}),
                  ...(r.oaUrl ? { oaUrl: r.oaUrl } : {}),
                  ...(r.doi ? { doi: r.doi } : {}),
                  ...(r.retracted !== undefined ? { retracted: r.retracted } : {}),
                  ...(r.type ? { type: r.type } : {}),
                  ...(r.topic ? { topic: r.topic } : {}),
                  ...(r.authors?.length ? { authors: r.authors } : {}),
                  ...(r.institutions?.length ? { institutions: r.institutions } : {}),
                  ...(r.refCount !== undefined ? { refCount: r.refCount } : {}),
                  ...(r.orcids?.length ? { orcids: r.orcids } : {}),
                  ...(r.retractionNotice ? { retractionNotice: r.retractionNotice } : {}),
                  ...(r.language ? { language: r.language } : {}),
                  ...(r.publicationStatus ? { publicationStatus: r.publicationStatus } : {}),
                  ...(r.dataAvailability?.length ? { dataAvailability: r.dataAvailability } : {}),
                  ...(r.fullTextUrls?.length ? { fullTextUrls: r.fullTextUrls } : {}),
                  ...(r.subjects?.length ? { subjects: r.subjects } : {}),
                  ...(r.compounds?.length ? { compounds: r.compounds } : {}),
                  ...(r.funding?.length ? { funding: r.funding } : {}),
                  ...(r.fwci !== undefined ? { fwci: r.fwci } : {}),
                  ...(r.refs?.length ? { refs: r.refs } : {}),
                  ...(r.related?.length ? { related: r.related } : {}),
                  ...(r.openalexId ? { openalexId: r.openalexId } : {}),
                  ...(r.europepmcId ? { europepmcId: r.europepmcId } : {}),
                  ...(r.europepmcSource ? { europepmcSource: r.europepmcSource } : {}),
                  ...(r.pmid ? { pmid: r.pmid } : {}),
                  ...(r.pmcid ? { pmcid: r.pmcid } : {}),
                  ...(r.field ? { field: r.field } : {}),
                  ...(r.keywords?.length ? { keywords: r.keywords } : {}),
                  ...(r.recentCitations !== undefined ? { recentCitations: r.recentCitations } : {}),
                  ...(r.citationTrend ? { citationTrend: r.citationTrend } : {}),
                  ...(r.content ? { abstract: r.content } : {}),
                }
                : {}),
              ...(typeof r.content === "string" && r.content ? { contentLength: r.content.length } : {}),
            })),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Actionable errors: tell the agent what to do next. Papers errors
        // are already contract-shaped (named backend, retry index, status) —
        // passed verbatim; a generic rewriter would strip the recovery path.
        let error: string;
        if (err instanceof PaperError) {
          error = err.message;
        } else if (err instanceof OpenAISearchUnavailableError) {
          error = err.message;
        } else if (/DuckDuckGo/i.test(message)) {
          error = "Search failed. Try provider: 'exa' or rephrase with a descriptive query.";
        } else if (/rate.?limit/i.test(message)) {
          error = provider === "parallel"
            ? "Search failed. Parallel is rate limited — wait and retry, or run /search-setup parallel to add a key."
            : "Search failed. Run /search-setup exa to replace the key, or wait and retry.";
        } else if (/no.*key|not.*configured|missing/i.test(message)) {
          error = "Search failed. Run /search-setup exa to configure an Exa API key.";
        } else if (/no.*results|parseable/i.test(message)) {
          error = "No results found. Try a more descriptive query, an earlier page, or a different provider.";
        } else if (/timeout|ECONNREFUSED|fetch.*fail/i.test(message)) {
          error = "Search failed. Check your network connection and retry.";
        } else {
          error = `Search failed (${message}). Try a different query or provider.`;
        }
        // Never expose raw internal errors — agent only sees actionable guidance
        return {
          content: [{ type: "text", text: error }],
          details: { error },
        };
      } finally {
        notifyExaIssueOnce(ctx);
        notifyParallelIssueOnce(ctx);
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Fetch as Markdown",
    description:
      "Fetch URL(s) as clean Markdown. Known sites come back structured in one call: " +
      "GitHub (repo and /tree/... URLs return a local checkout — read or bash the path; " +
      "releases and blob URLs return their content; issues and PRs return the complete " +
      "document — state, checks rollup, review verdicts, files, commits, comments — " +
      "via gh auth when available, so private repos render too), GitLab, package registries " +
      "(npm, PyPI, crates.io, …), Wikipedia, Reddit, Stack Exchange, arXiv, HN (item pages " +
      "and listings), ORCID researcher profiles (orcid.org/{id} — name, affiliations, public works), " +
      "and RSS/Atom feeds (.xml, .rss, .atom, /feed). " +
      "mode:'raw' returns the exact response body with a status and content-type label — " +
      "for metadata inspection, structured data in pages, or debugging extraction. " +
      "topic extracts just the matching sections of long pages. " +
      "prompt answers a question about the fetched content using the current model. " +
      "Accepts one URL string or an array of URLs. " +
      "For several pages from one site, use web_crawl instead.",
    promptSnippet:
      "Use to read full page content from known URLs (docs, articles, issues); " +
      "GitHub repos return a local checkout in one call.",
    parameters: webFetchParams,
    ...webFetchRenderers,
    async execute(
      _callId: string,
      params: WebFetchParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<FetchDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<FetchDetails>> {
      try {
        const urls = Array.isArray(params.urls) ? params.urls : [params.urls];
        const results = await fetchContent(urls, {
          maxChars: params.maxChars,
          signal,
          topic: params.topic,
          mode: params.mode,
          // Mid-run feedback: the transcript holds this line (renderResult's
          // isPartial branch) until the real result lands — the words come
          // from the deep module (system voice, state-only) because only it
          // knows tiers and cache hits mid-flight. The call row already
          // carries the URL, so the lines never repeat it.
          onEvent: (note) => onUpdate?.({ content: [{ type: "text", text: note }], details: {} }),
        });

        // Summarize the pages if a prompt was given.
        if (params.prompt) {
          interface Fetchable extends FetchResult {
            content: string;
          }
          const ok = results.filter((r): r is Fetchable => !r.error && r.content.length > 0);
          if (ok.length === 0) {
            return {
              content: [{ type: "text", text: "No fetchable content to summarize." }],
              details: { results },
            };
          }
          const summary = await summarizeContent(
            { prompt: params.prompt, sources: ok, model: params.model },
            ctx,
            signal,
          );
          const summaryText = [`## Summary (${summary.model})`, "", summary.text, "", "---", ""]
            .concat(results.map((r) => r.error
              ? `### ${r.url}\n\nError: ${r.error}`
              : `### ${r.url}\n\n${r.content}`))
            .join("\n");
          return {
            content: [{ type: "text", text: summaryText }],
            details: { summarized: true, model: summary.model, summary: summary.text, results },
          };
        }

        const text = results
          .map((r) => r.error
            ? `### ${r.url}\n\nError: ${r.error}`
            : `### ${r.title || r.url}\n\n${r.content}`)
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text", text: text || "No content." }],
          details: { results },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let hint = "";
        if (/Failed to parse URL/i.test(message)) {
          hint = "Check the URL format — must start with http:// or https://.";
        } else if (/fetch.*fail|ECONNREFUSED|ENOTFOUND/i.test(message)) {
          hint = "The URL may be unreachable. Verify it's correct and try again.";
        } else if (/HTTP\s+(4[0-9]{2}|5[0-9]{2})/i.test(message)) {
          hint = "The server returned an error. The URL may require authentication or be blocked.";
        } else if (/Unsupported content type/i.test(message)) {
          hint = "This content type is not supported. The URL may still work via remote fallback.";
        } else if (/timeout/i.test(message)) {
          hint = "The request timed out. Try again or use a different URL.";
        } else {
          hint = `The fetch failed (${message}). Check the URL and try again.`;
        }
        // Never expose raw internal errors — agent only sees actionable guidance
        return {
          content: [{ type: "text", text: `web_fetch failed: ${hint}` }],
          details: { error: hint },
        };
      } finally {
        notifyExaIssueOnce(ctx);
      }
    },
  });

  const webCrawlParams = Type.Object({
    seed: Type.String({ description: "Entry URL for the sweep. The crawl stays on this host and, " +
      "when the site has a sitemap, harvests its entries under this path; otherwise it follows " +
      "same-origin links from this page. For known single URLs use web_fetch instead." }),
    maxPages: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 25,
      description: "Pages to harvest before stopping (default 8, max 25). " +
        "The result reports capped vs complete.",
    })),
    depth: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 3,
      description: "Link hops from the seed on the link-following path (default 1, max 3). " +
        "Inert when a sitemap supplies the inventory.",
    })),
  });
  type WebCrawlParams = Static<typeof webCrawlParams>;

  pi.registerTool({
    name: "web_crawl",
    label: "Crawl a site section",
    description:
      "Sweep several pages from one site in one call — docs sections, changelogs, wiki " +
      "categories. Harvests up to maxPages pages (sitemap entries under the seed's path when " +
      "the site has one, else same-origin links from the seed), extracts each to clean " +
      "Markdown, and returns an inventory with a short excerpt per page. The result reports " +
      "capped vs complete: capped means more pages exist — raise maxPages or narrow the seed. " +
      "Follow up with web_fetch for the full content of the pages worth reading. " +
      "Same origin as the seed only.",
    promptSnippet:
      "Use to sweep several pages from one site (docs sections, changelogs); " +
      "returns an inventory with excerpts — follow up with web_fetch for full pages.",
    parameters: webCrawlParams,
    ...webCrawlRenderers,
    async execute(
      _callId: string,
      params: WebCrawlParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<CrawlDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<CrawlDetails>> {
      try {
        // Progress notes ride the tool's onUpdate channel (mirrors
        // fetch.ts's onEvent notes). crawl() emits them only for real
        // waits — the cold one-time dependency download.
        onUpdate?.({
          content: [{ type: "text", text: "Crawling…" }],
          details: {},
        });
        const result = await crawl(params.seed, {
          maxPages: params.maxPages,
          depth: params.depth,
          signal,
          onEvent: (note) => onUpdate?.({ content: [{ type: "text", text: note }], details: {} }),
        });
        const state = result.capped
          ? `capped — ${Math.max(0, result.found - result.pages.length)} more exist; ` +
            "raise maxPages or narrow the seed"
          : "complete";
        const rows = result.pages.map((p, i) => p.error
          ? `${i + 1}. ${p.url}\n   Error: ${p.error}`
          : `${i + 1}. ${p.title || p.url} — ${p.url} (${p.content.length} chars)\n` +
            `   ${excerptOf(p.content)}`);
        const text = [
          `Swept ${result.pages.length} page${result.pages.length === 1 ? "" : "s"} ` +
            `(${state} · via ${result.source})`,
          "",
          ...rows,
          "",
          "Follow up with web_fetch for the full content of any page above.",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            source: result.source,
            capped: result.capped,
            found: result.found,
            results: result.pages,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hint = /abort/i.test(message)
          ? "Crawl aborted."
          : `The crawl failed (${message}). Check the seed URL and try again, ` +
            "or fetch known pages directly with web_fetch.";
        return {
          content: [{ type: "text", text: `web_crawl failed: ${hint}` }],
          details: { error: hint },
        };
      }
    },
  });
}