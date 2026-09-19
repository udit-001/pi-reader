import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { htmlToMarkdown } from "./html.ts";

export type FetchMode = "light" | "full";

export interface ExecFn {
  (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

export interface FetchContext {
  mode: FetchMode;
  /** Cache entry directory. Put downloaded trees under join(entryDir, "tree"). */
  entryDir: string;
  signal?: AbortSignal;
  exec?: ExecFn;
}

export interface HandlerResult {
  /** e.g. "article", "readme", "repo", "package", "search" */
  kind: string;
  title?: string;
  /** Main text, cached as content.md */
  content: string;
  /** True when files were placed under entryDir/tree (clone, package extract). */
  hasTree?: boolean;
}

export interface MagpiHandler {
  name: string;
  description: string;
  match(url: URL): boolean;
  fetch(url: URL, ctx: FetchContext): Promise<HandlerResult>;
}

const UA = "Mozilla/5.0 (compatible; pi-reader/0.3)";
const TEXT_CAP = 5 * 1024 * 1024; // 5MB of text is already absurd for an LLM cache
const DOWNLOAD_CAP = 100 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;

/**
 * Ceiling for one whole fetch, by mode.
 * The per-request timeout above bounds a single call, not a handler that makes several in a row, and nothing at all bounds a dns lookup, a clone, or pdf text extraction.
 * Full mode gets the looser figure because it clones repos and unpacks archives.
 */
export const FETCH_DEADLINE_MS: Record<FetchMode, number> = { light: 90_000, full: 300_000 };

export class FetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // v4-mapped v6
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const low = ip.toLowerCase();
  return low === "::" || low === "::1" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
}

/**
 * SSRF guard: model-supplied URLs must not reach loopback, link-local, or private-range addresses (cloud metadata endpoints, intranet services).
 * Checks the scheme, the hostname, literal IPs, and DNS-resolved addresses.
 */
export async function assertPublicTarget(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`Unsupported scheme ${url.protocol}//; only http and https are fetchable`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const blocked = (why: string) =>
    new FetchError(`Blocked: ${why}. Set allowPrivateNetwork in pi-reader.json to permit private-network fetches.`);
  if (host === "localhost" || host.endsWith(".localhost")) throw blocked(`${host} is loopback`);
  if (isIP(host)) {
    if (isPrivateIp(host)) throw blocked(`${host} is a private address`);
    return;
  }
  // Preflight resolves the name once; a redirect hop to a private address can still slip through.
  // Upgrade path: manual redirect loop in httpGet.
  try {
    // node's dns lookup takes no signal and can sit on a threadpool slot forever, so the preflight gets its own clock.
    const addrs = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`dns lookup for ${host} timed out`)), DNS_TIMEOUT_MS).unref();
      }),
    ]);
    if (addrs.some((a) => isPrivateIp(a.address))) throw blocked(`${host} resolves to a private address`);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    // DNS failure: let the fetch itself fail with the natural error
  }
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/**
 * Run `work` under a hard deadline.
 * Aborting is a request, not a guarantee: extraction and archive walks are plain cpu work that ignores the signal, so the deadline also rejects on its own and hands the caller back its turn.
 */
export function withDeadline<T>(
  ms: number,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  const scoped = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return Promise.race([
    work(scoped),
    new Promise<never>((_, reject) => {
      deadline.addEventListener("abort", () =>
        reject(new FetchError(`Fetch gave up after ${Math.round(ms / 1000)}s`)),
      );
    }),
  ]);
}

export const MAX_REDIRECTS = 8;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Resolve a redirect hop; null when the response is not a redirect or has no Location. */
export function redirectTarget(res: Response, currentUrl: string): URL | null {
  if (!REDIRECT_STATUSES.has(res.status)) return null;
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    return new URL(loc, currentUrl);
  } catch {
    return null;
  }
}

/** Read a response body with a hard byte cap — unbounded res.text() is an OOM vector. */
export async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= cap) {
      void reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function httpGet(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new FetchError(`Invalid URL: ${url}`);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Per-hop SSRF validation: the preflight only covers the initial URL, and
    // a redirect hop to a private address must not slip through.
    await assertPublicTarget(current);
    const res = await fetch(current.href, {
      signal: withTimeout(signal),
      headers: { "user-agent": UA, ...headers },
      redirect: "manual",
    });
    const next = redirectTarget(res, current.href);
    if (!next) return res;
    if (hop === MAX_REDIRECTS) throw new FetchError(`Too many redirects for ${url}`);
    void res.body?.cancel().catch(() => {});
    current = next;
  }
  throw new FetchError(`Too many redirects for ${url}`);
}

export async function getText(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<{ text: string; contentType: string; finalUrl: string }> {
  const res = await httpGet(url, signal, headers);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > TEXT_CAP) throw new FetchError(`Response too large (${len} bytes) for ${url}`);
  let text = await readBodyCapped(res, TEXT_CAP);
  return {
    text,
    contentType: res.headers.get("content-type") ?? "",
    finalUrl: res.url || url,
  };
}

export async function getJson<T = unknown>(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await httpGet(url, signal, { accept: "application/json", ...headers });
  return (await res.json()) as T;
}

export async function download(url: string, destFile: string, signal?: AbortSignal): Promise<void> {
  const res = await httpGet(url, signal);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > DOWNLOAD_CAP) throw new FetchError(`Download exceeds ${DOWNLOAD_CAP} bytes`);
  writeFileSync(destFile, buf);
}

/** System bsdtar handles tar/tgz/zip on Win10+/mac/linux; saves a JS tar dep. */
export async function extractArchive(archive: string, destDir: string, exec: ExecFn, signal?: AbortSignal): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const r = await exec("tar", ["-xf", archive, "-C", destDir], { signal, timeout: 60_000 });
  if (r.code !== 0) throw new FetchError(`Archive extraction failed: ${r.stderr.slice(0, 300)}`);
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "target", "dist", "build"]);

export interface TreeSummary {
  fileCount: number;
  listing: string;
  readme?: string;
}

/** Walk a downloaded tree: find a README and produce a capped file listing. */
export function summarizeTree(dir: string, maxFiles = 400): TreeSummary {
  const files: string[] = [];
  let readmePath: string | undefined;
  const walk = (d: string, rel: string) => {
    if (files.length >= maxFiles) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name), relPath);
      } else {
        files.push(relPath);
        if (!readmePath && /^readme(\.(md|rst|txt|markdown))?$/i.test(e.name)) {
          readmePath = join(d, e.name);
        }
      }
    }
  };
  walk(dir, "");
  let readme: string | undefined;
  if (readmePath) {
    try {
      readme = readFileSync(readmePath, "utf8").slice(0, TEXT_CAP);
    } catch {
      // unreadable readme; listing still useful
    }
  }
  return { fileCount: files.length, listing: files.sort().join("\n"), readme };
}

/** Shallow-clone into entryDir/tree; content = README + capped file listing. */
export async function cloneRepo(cloneUrl: string, ctx: FetchContext): Promise<HandlerResult> {
  if (!ctx.exec) throw new FetchError("exec not available");
  const treeDir = join(ctx.entryDir, "tree");
  const r = await ctx.exec("git", ["clone", "--depth", "1", cloneUrl, treeDir], {
    signal: ctx.signal,
    timeout: 120_000,
  });
  if (r.code !== 0) throw new FetchError(`git clone failed: ${r.stderr.slice(0, 300)}`);
  const tree = summarizeTree(treeDir);
  const content = [
    tree.readme ?? "(no README found)",
    `\n\n## Files (${tree.fileCount}${tree.fileCount >= 400 ? "+" : ""})\n`,
    tree.listing,
  ].join("\n");
  return { kind: "repo", content, hasTree: true };
}

async function pdfToText(buf: ArrayBuffer): Promise<string> {
  // unpdf 1.8's bundled PDF.js calls this ES2026 API despite declaring Node >=22.
  (Math as any).sumPrecise ??= (values: Iterable<number>) => Array.from(values).reduce((sum, n) => sum + n, 0);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text, totalPages } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
  return `${text.trim()}\n\n(${totalPages} pages)`;
}

/**
 * The default fetch pipeline: GET -> (pdf ? extract : html ? readability+markdown : as-is).
 * Checks for llms.txt first: sites that publish it have already done the extraction for us.
 * Every handler is built on this via defineHandler; specialized handlers override fetch but reuse the same http/extract helpers, so the tested plumbing is shared.
 */
export const defaultFetch = async (url: URL, ctx: FetchContext): Promise<HandlerResult> => {
  const probes = ctx.mode === "full" ? ["llms-full.txt", "llms.txt"] : url.pathname === "/" ? ["llms.txt"] : [];
  for (const name of probes) {
    try {
      const r = await getText(`${url.origin}/${name}`, ctx.signal);
      if (!/html/i.test(r.contentType) && r.text.trim()) return { kind: "llms-txt", content: r.text };
    } catch {
      // site does not publish it
    }
  }

  const res = await httpGet(url.href, ctx.signal);
  const contentType = res.headers.get("content-type") ?? "";
  if (/application\/pdf/i.test(contentType) || /\.pdf$/i.test(url.pathname)) {
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > DOWNLOAD_CAP) throw new FetchError(`PDF too large (${len} bytes) for ${url.href}`);
    return { kind: "pdf", content: await pdfToText(await res.arrayBuffer()) };
  }

  let text = await readBodyCapped(res, TEXT_CAP);
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) {
    const page = htmlToMarkdown(text, url.href);
    return { kind: "article", title: page.title, content: page.markdown };
  }
  if (/json/i.test(contentType)) {
    try {
      return { kind: "json", content: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      // fall through: serve raw
    }
  }
  return { kind: "text", content: text };
};

/** Handler template. Omit fetch to get the default pipeline. */
export function defineHandler(def: {
  name: string;
  description?: string;
  match: (url: URL) => boolean;
  fetch?: (url: URL, ctx: FetchContext) => Promise<HandlerResult>;
}): MagpiHandler {
  if (!def.name || typeof def.match !== "function") {
    throw new Error("handler needs at least { name, match }");
  }
  return { description: "", fetch: defaultFetch, ...def };
}
