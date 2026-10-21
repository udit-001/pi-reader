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

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { hasUvx, uvxBinary } from "../search/ddgs-uv.ts";

const execFileAsync = promisify(execFile);

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
            pages.append({"url": url, "title": "", "text": "",
                          "error": f"Fetch failed ({e})"})
            continue
        pages.append(extract_page(html, url))
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
            pages.append(extract_page(html, u))
    else:
        source = "links"
        pages, exhausted, found = crawl_links(seed, max_pages, depth, deadline)
    print(json.dumps({"source": source, "exhausted": exhausted,
                      "found": found, "pages": pages}))


if __name__ == "__main__":
    main()
`;

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
 *  reports its state; the exec timeout is the hard outer bound. */
export async function crawlViaUv(
  seed: string,
  options: { maxPages: number; depth: number; deadlineMs: number },
  signal?: AbortSignal,
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
    const { stdout } = await execFileAsync(uvxBinary(), args, {
      timeout: CRAWL_EXEC_TIMEOUT_MS,
      maxBuffer: DRIVER_MAX_BUFFER,
      signal,
    });
    return parseCrawlDriverOutput(stdout);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
