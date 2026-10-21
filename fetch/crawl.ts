// crawl.ts — deep module: a bounded sweep of one site section.
//
// The module's interface is one call: seed + budgets in, a CrawlResult out.
// Everything a caller (index.ts, one call site) would otherwise have to know
// lives here: seed validation, backend selection, the budget contract, the
// capped-vs-complete call, and the per-page excerpt for the agent-facing
// inventory. The sweep→read flow shapes this result: the inventory tells the
// agent what exists and what is worth reading; full pages come from a
// follow-up web_fetch, not from this call.
//
// Two adapters satisfy one interface — that is what makes the seam real:
//   crawl-uv.ts  trafilatura driver via uv (sitemap-first, then link walk)
//   jsCrawl()    the plugin's own chain: link discovery over the fetched
//                seed's markdown, harvest through fetchContent
// Both return the same Page shape the fetch pipeline renders, so the
// transcript view (fetchView) carries over untouched.

import { fetchContent } from "./fetch.ts";
import { assertPublicTarget } from "./handlers/handler.ts";
import { crawlUvAvailable, crawlViaUv, type DriverOutput } from "./crawl-uv.ts";

// ── Budgets — the contract every adapter satisfies ──────────────────────────

export const DEFAULT_MAX_PAGES = 8;
export const MAX_MAX_PAGES = 25;
export const DEFAULT_DEPTH = 1;
export const MAX_DEPTH = 3;
/** Whole-crawl wall-clock budget handed to the uv driver; the JS fallback
 *  leans on fetchContent's own per-request timeouts. */
export const CRAWL_DEADLINE_MS = 90_000;
/** Agent-facing excerpt budget — enough to triage a page, not to read it. */
export const EXCERPT_CHARS = 280;

const SKIP_EXTENSIONS = [
  ".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".webp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf", ".zip", ".gz",
  ".xml", ".rss", ".atom", ".mp4", ".webm", ".mp3", ".txt",
];

// ── Result shape — the Page object the fetch pipeline already knows ─────────

export interface CrawlPage {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export interface CrawlResult {
  /** Which adapter supplied the inventory. */
  source: "sitemap" | "links" | "js";
  /** True when the sweep stopped on budget — more pages exist than shown. */
  capped: boolean;
  /** Total URLs the backend knew about (sitemap entries or pages visited). */
  found: number;
  pages: CrawlPage[];
}

export interface CrawlOptions {
  maxPages?: number;
  depth?: number;
  signal?: AbortSignal;
}

// ── Pure seam (exported for tests) ───────────────────────────────────────────

/** True for an http(s) URL — the only kind a crawl can start from. */
export function isCrawlableUrl(seed: string): boolean {
  try {
    const parsed = new URL(seed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Candidate links in the seed's raw HTML, scoped for the sweep: same host
 *  as the seed, fragments dropped, non-page extensions dropped (query string
 *  normalized first — docs sites suffix assets with `?digest=...`), deduped,
 *  capped. Order preserved — discovery order is traversal order. The seed
 *  itself is never its own candidate. */
export function candidateLinks(html: string, seed: string, cap: number): string[] {
  let seedUrl: URL;
  try {
    seedUrl = new URL(seed);
  } catch {
    return [];
  }
  const seen = new Set<string>([seedUrl.href]);
  const out: string[] = [];
  const href = /\bhref\s*=\s*["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(href)) {
    let abs: URL;
    try {
      abs = new URL(match[1]!.trim(), seedUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (abs.hostname !== seedUrl.hostname) continue;
    abs.hash = "";
    const path = decodeURIComponent(abs.pathname).toLowerCase();
    if (SKIP_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    if (seen.has(abs.href)) continue;
    seen.add(abs.href);
    out.push(abs.href);
    if (out.length >= cap) break;
  }
  return out;
}

/** The inventory's per-page excerpt: enough to judge what the page is, not
 *  to read it. Whitespace flattened, cut plain (no style resets — the
 *  black-band lesson applies to agent content too). */
export function excerptOf(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

/** Adapter output → result. The capped call: the driver reports whether it
 *  drained its frontier; not-drained means budget-struck, and `found` says
 *  how much exists beyond the harvest. */
export function shapeCrawl(out: DriverOutput, maxPages: number): CrawlResult {
  const pages: CrawlPage[] = (out.pages ?? []).map((p) => ({
    url: p.url,
    title: p.title ?? "",
    content: p.text ?? "",
    error: p.error ?? null,
  }));
  return {
    source: out.source === "sitemap" ? "sitemap" : "links",
    capped: out.exhausted === false,
    found: out.found ?? pages.length,
    pages,
  };
}

// ── The sweep ─────────────────────────────────────────────────────────────────

/** Sweep one site section. The uv adapter is preferred; any uv failure —
 *  missing toolchain, dead driver, bad output — falls through to the JS
 *  path, so the sweep still happens. Abort rides through untouched.
 *
 *  The seed passes the same public-target guard every fetch runs, and the
 *  driver mirrors it internally (pre-connect DNS check, per-hop redirect
 *  check) because its fetches live outside Node's httpGet. Same-origin
 *  pinning in both adapters keeps every harvested URL on the validated
 *  seed host. Residual: the driver's DNS check and connect are two steps —
 *  the rebinding window Node closes with a pinned lookup stays open here,
 *  narrowed to a host already validated public at dispatch. */
export async function crawl(seed: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  if (!isCrawlableUrl(seed)) {
    throw new Error(`Seed must be an http(s) URL, got: ${seed}`);
  }
  await assertPublicTarget(new URL(seed));
  const maxPages = clamp(options.maxPages ?? DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
  const depth = clamp(options.depth ?? DEFAULT_DEPTH, 1, MAX_DEPTH);

  if (crawlUvAvailable()) {
    try {
      const out = await crawlViaUv(
        seed,
        { maxPages, depth, deadlineMs: CRAWL_DEADLINE_MS },
        options.signal,
      );
      return shapeCrawl(out, maxPages);
    } catch (err) {
      if (options.signal?.aborted || isAbortError(err)) throw err;
      // Fall through — the sweep still happens on the plugin's own chain.
    }
  }
  return jsCrawl(seed, maxPages, options.signal);
}

/** The JS adapter: discover from the seed's raw HTML (the markdown
 *  extractor strips links entirely — the discovery probe must be raw), then
 *  harvest each candidate through the full fetch chain (local → Jina →
 *  markdown.new → Exa — JS-rendered pages included). Capped when the seed
 *  yielded at least the budget's worth of candidates. */
async function jsCrawl(seed: string, maxPages: number, signal?: AbortSignal): Promise<CrawlResult> {
  const probe = await fetchContent([seed], { mode: "raw", maxChars: 250_000, signal });
  const raw = probe[0];
  if (!raw || raw.error || !raw.content) {
    throw new Error(raw?.error || "Seed page returned no HTML to sweep from");
  }
  const links = candidateLinks(raw.content, seed, maxPages - 1);
  const capped = links.length >= maxPages - 1 && maxPages > 1;
  const targets = [seed, ...links];
  const results = await fetchContent(targets, { signal });
  return {
    source: "js",
    capped,
    found: targets.length,
    pages: results.map((r) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      error: r.error,
    })),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
