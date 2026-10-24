// crawl-uv.ts — site crawl via the trafilatura Python package (uv).
//
// Adapter at the crawl seam (fetch/crawl.ts owns the interface and the
// policy): seed in, JSON out. The embedded Python driver does the work:
// sitemap-first discovery (trafilatura's sitemap_search: robots.txt probing,
// sitemap indexes, gzip) scoped to the seed's directory, falling back to a
// same-origin breadth-first walk from the seed's links. Per-page extraction
// is trafilatura's, capped per page so the JSON pipe stays small; one bad
// page becomes an error row, never a dead crawl.
//
// The driver is a data slot for its arguments (argv-array exec — the seed is
// model-supplied) and shares uv resolution with ddgs-uv; nothing here
// duplicates it. The parse seam below is the test surface: fixtures in, pages
// out — the network and the Python process are not unit-tested.

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { hasUvx, uvxBinary } from "../search/ddgs-uv.ts";
import { loadConfig, saveConfig, configPath } from "../config.ts";

const execFileAsync = promisify(execFile);

// ── Cold-start warm probe ───────────────────────────────────────────────────

/** Download-only budget, decoupled from the crawl exec timeout: uv's first
 *  trafilatura download (lxml wheels included, ~30 MB) must never eat the
 *  crawl's own 150 s window. Cached forever after the first success. */
export const WARM_TIMEOUT_MS = 180_000;

/** Probe command for the warm check: imports trafilatura, forcing uv to
 *  resolve and cache the inline dependency. Pure — tests pin the plan. */
export function warmProbeCommand(uvxBin: string): string[] {
  return [uvxBin, "--with", "trafilatura", "python", "-c", "import trafilatura"];
}

/** The cold-start flow: the note is a once-per-MACHINE event, so it is gated
 *  on a persisted marker, not on a stopwatch — a fast download is still the
 *  first download (a racy 5s probe once hid the note from a first-time user).
 *  No marker → note + warm + onWarmed() on success. Marker set → silence.
 *  Warm failure stays silent: the crawl's degrade notice is the surface, and
 *  the unmarked state lets a later cold crawl announce again (correct: still
 *  unwarmed). Exported as an internal seam so tests pin the flow without
 *  spawning processes or touching real config. */
export async function crawlWarmFlow(
  probeArgs: string[],
  firstEver: boolean,
  run: (args: string[], timeout: number) => Promise<unknown>,
  onNote?: (note: string) => void,
  onWarmed?: () => void,
): Promise<void> {
  if (!firstEver) return;
  onNote?.("Downloading crawl backend (trafilatura) — one-time");
  try {
    await run(probeArgs, WARM_TIMEOUT_MS);
  } catch {
    return; // no marker — a later cold crawl announces again (still unwarmed)
  }
  onWarmed?.();
}

/** Fire-and-forget warm for the crawl backend: announces the one-time download
 *  exactly once per machine (marker in shared config), then caches the
 *  trafilatura inline dep off the crawl's exec timeout. Once per process.
 *  Returns the promise so tests can await; callers may ignore. */
let crawlWarmDone = false;
export function warmCrawlUv(onNote?: (note: string) => void): Promise<void> {
  if (crawlWarmDone) return Promise.resolve();
  crawlWarmDone = true;
  const config = loadConfig() ?? { version: 1 };
  if (config.hints?.crawlBackendWarmed) return Promise.resolve();
  return crawlWarmFlow(
    warmProbeCommand(uvxBinary()),
    true,
    async (args, timeout) => {
      await execFileAsync(args[0]!, args.slice(1), { timeout });
    },
    onNote,
    () => {
      // Re-read: a concurrent save between our load and now must not be dropped.
      const fresh = loadConfig() ?? { version: 1 };
      saveConfig(configPath(), {
        ...fresh,
        hints: { ...fresh.hints, crawlBackendWarmed: true },
      });
    },
  );
}

/** True when the uv toolchain is present — the gate crawl.ts uses to pick
 *  this adapter. */
export function crawlUvAvailable(): boolean {
  return hasUvx();
}

// ── Driver contract (what crawl.ts reads) ───────────────────────────────────

export interface DriverPage {
  url: string;
  title?: string;
  text?: string;
  error?: string | null;
}

export interface DriverOutput {
  /** Which discovery path supplied the inventory. */
  source?: "sitemap" | "links";
  /** True when the driver drained its frontier (complete sweep); false when
   *  it stopped on budget — crawl.ts turns that into the capped state. */
  exhausted?: boolean;
  /** Total URLs the driver knew about (sitemap entries or pages visited). */
  found?: number;
  pages?: DriverPage[];
}

// ── The embedded Python driver ───────────────────────────────────────────────

const DRIVER = `
import gzip, html as htmllib, ipaddress, json, re, socket, sys, time
from urllib.error import URLError
from urllib.parse import urljoin, urlparse, unquote
from urllib.request import HTTPRedirectHandler, Request, build_opener

import lxml.html
import trafilatura
from trafilatura.sitemaps import sitemap_search

SKIP_EXTENSIONS = (".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".gif",
    ".svg", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf", ".zip", ".gz", ".xml", ".rss", ".atom", ".mp4", ".webm", ".mp3",
    ".txt")
TEXT_CAP = 2400
UA = {"User-Agent": "Mozilla/5.0 (compatible; pi-reader-crawl)"}


def _assert_public_host(url):
    """Refuse loopback, link-local, private, and reserved targets. Runs before
    every fetch and on every redirect hop — the same policy Node's httpGet
    guard applies to the fetch chain, mirrored here because the driver's
    fetches live outside Node."""
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise URLError("unsupported scheme")
    port = p.port or (443 if p.scheme == "https" else 80)
    for info in socket.getaddrinfo(p.hostname, port):
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast):
            raise URLError(f"refusing non-public address for {p.hostname}")


class GuardedRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _assert_public_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class NonHTML(Exception):
    """Fetched something that is not a page (CSS, JS, JSON) — skip, not a row."""


_OPENER = build_opener(GuardedRedirect)


def guarded_fetch(url, timeout=20):
    """(bytes, content-type) for a URL with the public-target guard:
    pre-connect DNS check, per-hop redirect check."""
    _assert_public_host(url)
    req = Request(url, headers=UA)
    with _OPENER.open(req, timeout=timeout) as res:
        data = res.read()
        ctype = res.headers.get("Content-Type", "")
    if url.lower().endswith(".gz"):
        data = gzip.decompress(data)
    return data, ctype


def fetch_html(url):
    data, ctype = guarded_fetch(url)
    if "text/html" not in ctype:
        raise NonHTML(ctype)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def is_page_url(url):
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        return False
    path = unquote(p.path).split("?")[0].lower()
    return not path.endswith(SKIP_EXTENSIONS)


def same_host(url, host):
    return urlparse(url).netloc == host


def sitemap_urls(seed, deadline):
    """Page links from the site's sitemaps, scoped to the seed's directory.
    sitemap_search handles robots.txt discovery, sitemap indexes and gzip
    itself and returns same-host links directly — no XML parsing here. It
    wants the site root as input: a deep seed triggers its URL filter down
    to that page's path and matches almost nothing."""
    parsed = urlparse(seed)
    site = f"{parsed.scheme}://{parsed.netloc}/"
    seed_dir = seed.rsplit("/", 1)[0] + "/"
    host = parsed.netloc
    try:
        links = sitemap_search(site, sleep_time=1.0, max_sitemaps=10) or []
    except Exception:
        return []
    urls, seen = [], set()
    for u in links:
        if time.time() > deadline:
            break
        u = str(u).split("#")[0]
        if u in seen or not is_page_url(u) or not same_host(u, host):
            continue
        if not u.startswith(seed_dir):
            continue
        if u not in urls:
            urls.append(u)
    return urls


def extract_links(html, base, host):
    links, seen = [], set()
    for _, _, href, *_ in lxml.html.fromstring(html).iterlinks():
        abs_url = urljoin(base, href.strip()).split("#")[0]
        if abs_url in seen or not is_page_url(abs_url) or not same_host(abs_url, host):
            continue
        seen.add(abs_url)
        links.append(abs_url)
    return links


def extract_page(html, url):
    try:
        text = trafilatura.extract(html, url=url, output_format="markdown",
                                   include_links=False)
        try:
            meta = trafilatura.extract_metadata(html)
            title = (meta.title if meta else None) or ""
        except Exception:
            # Metadata APIs drift between trafilatura versions; <title> is stable.
            m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
            title = htmllib.unescape(m.group(1)).strip() if m else ""
    except Exception as e:
        return {"url": url, "title": "", "text": "", "error": str(e)}
    if not text:
        return {"url": url, "title": title, "text": "",
                "error": "No extractable content"}
    if len(text) > TEXT_CAP:
        text = text[:TEXT_CAP] + " ...[cut]"
    return {"url": url, "title": title, "text": text, "error": None}


def emit_page(page):
    """NDJSON page event: one line per harvested page, flushed — Node reads
    these as they arrive (milestone notes, partial recovery on kill)."""
    print(json.dumps({"page": page}), flush=True)


def crawl_links(seed, max_pages, depth, deadline):
    """Breadth-first same-origin walk from the seed's links.
    Returns (pages, exhausted, visited_count)."""
    host = urlparse(seed).netloc
    visited, queue, pages = set(), [(seed, 0)], []
    deadline_hit = False
    while queue and len(pages) < max_pages:
        if time.time() > deadline:
            deadline_hit = True
            break
        url, d = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        try:
            html = fetch_html(url)
        except NonHTML:
            continue  # an asset endpoint, not a page — no row, no budget
        except Exception as e:
            page = {"url": url, "title": "", "text": "",
                    "error": f"Fetch failed ({e})"}
            pages.append(page)
            emit_page(page)
            continue
        page = extract_page(html, url)
        pages.append(page)
        emit_page(page)
        if d < depth:
            for link in extract_links(html, url, host):
                queue.append((link, d + 1))
    exhausted = not deadline_hit and len(pages) < max_pages and not queue
    return pages, exhausted, len(visited) + len(queue)


def main():
    seed = sys.argv[1]
    max_pages = int(sys.argv[2])
    depth = int(sys.argv[3])
    deadline = time.time() + float(sys.argv[4])

    urls = sitemap_urls(seed, deadline)
    if urls:
        source, found = "sitemap", len(urls)
        exhausted = found <= max_pages
        pages = []
        for u in urls[:max_pages]:
            if time.time() > deadline:
                exhausted = False
                break
            try:
                html = fetch_html(u)
            except NonHTML:
                continue
            page = extract_page(html, u)
            pages.append(page)
            emit_page(page)
    else:
        source = "links"
        pages, exhausted, found = crawl_links(seed, max_pages, depth, deadline)
    print(json.dumps({"source": source, "exhausted": exhausted,
                      "found": found, "pages": pages}))


if __name__ == "__main__":
    main()
`;

// ── NDJSON line protocol (driver stdout) ─────────────────────────────────────

/** Which kind of line the driver emitted. `skip` covers garbage (warnings,
 *  tracebacks, partial lines) — the protocol never kills the parse over it. */
export type DriverLine =
  | { kind: "page"; page: DriverPage }
  | { kind: "summary"; out: DriverOutput }
  | { kind: "skip" };

/** Parse one NDJSON line from the driver. Pure; the test surface for the
 *  streaming protocol. A line is a page event when it parses to an object
 *  with a `page` object; the summary when it parses with a `pages` array;
 *  everything else (unparseable, empty, both-shapes-missing) skips. */
export function parseCrawlDriverLine(raw: string): DriverLine {
  const trimmed = raw.trim();
  if (!trimmed || trimmed[0] !== "{") return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "skip" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "skip" };
  const obj = parsed as Record<string, unknown>;
  if (obj.page && typeof obj.page === "object") {
    return { kind: "page", page: obj.page as DriverPage };
  }
  if (Array.isArray(obj.pages)) return { kind: "summary", out: parsed as DriverOutput };
  return { kind: "skip" };
}

// ── uv invocation ─────────────────────────────────────────────────────────────

// uvxBinary() comes from ddgs-uv — one source of truth for uv resolution.

/** Parse seam: driver stdout → structured output. Tolerates log noise before
 *  the JSON; throws a recoverable error on anything unparseable. */
export function parseCrawlDriverOutput(raw: string): DriverOutput {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("crawl driver produced no JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw new Error("crawl driver produced unparseable output");
  }
  const out = parsed as DriverOutput;
  if (!Array.isArray(out.pages)) {
    throw new Error("crawl driver output is missing its pages list");
  }
  return out;
}

const CRAWL_EXEC_TIMEOUT_MS = 150_000;
const DRIVER_MAX_BUFFER = 4_000_000;

/** Run the embedded driver: `uvx --with trafilatura python <script> <args>`.
 *  Argv-array exec — the seed (model-supplied) stays one data slot; no shell.
 *  The deadline rides in as an argument so the driver stops harvesting and
 *  reports its state; the exec timeout is the hard outer bound. Stdout is
 *  NDJSON: a `"page"` line per harvested page (streamed to onPage as it
 *  arrives) plus the final summary line. A driver killed before its summary
 *  still returns the pages already parsed (partial recovery) instead of
 *  losing the whole sweep; zero pages and no summary throws, as before. */
export async function crawlViaUv(
  seed: string,
  options: { maxPages: number; depth: number; deadlineMs: number },
  signal?: AbortSignal,
  onPage?: (page: DriverPage) => void,
): Promise<DriverOutput> {
  // Private per-call dir (mkdtemp: exclusive random suffix, 0700) — the driver
  // is written by path, so a pre-placed file at a guessable path is not an option.
  const tmpDir = mkdtempSync(join(tmpdir(), "crawl-"));
  const script = join(tmpDir, "crawl_driver.py");
  writeFileSync(script, DRIVER, { mode: 0o600 });
  const args = [
    "--with", "trafilatura",
    "python", script,
    seed,
    String(options.maxPages),
    String(options.depth),
    String(Math.ceil(options.deadlineMs / 1000)),
  ];
  try {
    return await runCrawlDriver(
      [uvxBinary(), ...args],
      spawnCrawlDriver,
      onPage,
      validateDriverOutput,
      signal,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Shared validation from the collect-all parser — one shape contract. */
const validateDriverOutput = (out: DriverOutput): DriverOutput => {
  if (!Array.isArray(out.pages)) {
    throw new Error("crawl driver output is missing its pages list");
  }
  return out;
};

/** The real subprocess: spawn the driver, feed stdout line-by-line as they
 *  arrive, return the pages and summary the child produced before any death.
 *  Exposed as the default `spawnCrawl` dependency of runCrawlDriver so tests
 *  substitute a fake emitting line sequences. Timeout maps to killing the
 *  child — the caller then decides (summary? partial pages? throw). */
function spawnCrawlDriver(
  args: string[],
  onPage: ((page: DriverPage) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ summary: DriverOutput | null; pages: DriverPage[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      signal,
      timeout: CRAWL_EXEC_TIMEOUT_MS,
    });
    const rl = createInterface({ input: child.stdout! });
    const pages: DriverPage[] = [];
    let summary: DriverOutput | null = null;
    rl.on("line", (line) => {
      const parsed = parseCrawlDriverLine(line);
      if (parsed.kind === "page") {
        pages.push(parsed.page);
        onPage?.(parsed.page);
      } else if (parsed.kind === "summary") {
        summary = parsed.out;
      }
    });
    child.on("error", reject); // spawn failure (ENOENT) — nothing ran
    child.on("close", () => {
      if (summary) {
        // Keep the streamed page events as the canonical row list: identical
        // in the happy path, authoritative when the summary missed pages
        // (shouldn't happen, but pages-witnessed outranks summary-claimed).
        resolve({ summary, pages: pages.length > 0 ? pages : (summary.pages ?? []) });
      } else {
        resolve({ summary: null, pages });
      }
    });
  });
}


/** The protected core, dependency-injected so tests pin it without a real
 *  child. Outcome ladder: summary → summary (pages validated). No summary →
 *  ≥1 page → partial recovery { exhausted: false, found: page count }.
 *  No summary → 0 pages → throw (previous behavior, unchanged). */
export async function runCrawlDriver(
  args: string[],
  spawnCrawl: typeof spawnCrawlDriver,
  onPage: ((page: DriverPage) => void) | undefined,
  validate: (out: DriverOutput) => DriverOutput,
  signal?: AbortSignal,
): Promise<DriverOutput> {
  const { summary, pages } = await spawnCrawl(args, onPage, signal);
  if (summary) return validate(summary);
  if (pages.length > 0) {
    return validate({ exhausted: false, found: pages.length, pages });
  }
  throw new Error("crawl driver produced no JSON");
}
