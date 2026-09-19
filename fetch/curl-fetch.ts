// curl-backed fetch tier — the local rescue for bot-walled pages.
//
// Node's fetch gets 403s from sites (e.g. openai.com) that accept the same
// request from system curl with a real Chrome header set — the check fires on
// transport/header shape, not deep TLS. This module shells out to curl
// (present everywhere, zero dependencies) and, when a curl-impersonate binary
// is installed, prefers it for a true Chrome TLS fingerprint.
//
// Interface: curlGetText(url, opts) → { status, contentType, text } | null.
// Null means "curl unavailable / transport failed" — the caller keeps its
// fallback chain. https/http schemes only. Policy (which statuses trigger a
// retry) lives with the caller.
//
// buildCurlArgs and parseCurlResponse are exported for their own tests
// (not for callers).

import { execFile } from "node:child_process";
import { resolveValidatedHost, MAX_REDIRECTS } from "./handlers/handler.ts";

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const IMPERSONATE_BINARIES = [
  "curl-impersonate-chrome",
  "curl_chrome",
  "curl_chrome116",
  "curl_chrome124",
];

const MAX_CURL_BYTES = 16 * 1024 * 1024;

let binaryPromise: Promise<string | null> | undefined;

/** Resolve the best available curl binary; cached for the process lifetime. */
export function resolveCurlBinary(): Promise<string | null> {
  binaryPromise ??= (async () => {
    for (const bin of [...IMPERSONATE_BINARIES, "curl"]) {
      const ok = await new Promise<boolean>((resolve) => {
        execFile(bin, ["--version"], { timeout: 5_000 }, (err) => resolve(!err));
      });
      if (ok) return bin;
    }
    return null;
  })();
  return binaryPromise;
}

/** Forget the cached binary resolution (for tests). */
export function resetCurlBinaryCache(): void {
  binaryPromise = undefined;
}

export interface CurlArgsOptions {
  timeoutMs?: number;
  /** Extra curl args (e.g. cookie flags) — reserved for callers, rarely used. */
  extraArgs?: string[];
  /** Pre-validated addresses for the host: emitted as --resolve pins so curl
   *  connects only to addresses the SSRF guard checked (no DNS at connect). */
  resolves?: string[];
}

/** Build the full argv for one curl request. Pure; exported for tests. */
export function buildCurlArgs(url: string, opts: CurlArgsOptions = {}): string[] {
  const secs = Math.max(1, Math.round((opts.timeoutMs ?? 30_000) / 1000));
  const u = new URL(url);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return [
    "-sS",
    "--http2",
    "--compressed",
    "--max-time",
    String(secs),
    "--include",
    "--user-agent",
    CHROME_UA,
    "--header",
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "--header",
    "Accept-Language: en-US,en;q=0.9",
    "--header",
    'sec-ch-ua: "Chromium";v="131", "Not_A Brand";v="24"',
    "--header",
    "sec-ch-ua-mobile: ?0",
    "--header",
    'sec-ch-ua-platform: "Linux"',
    "--header",
    "Sec-Fetch-Dest: document",
    "--header",
    "Sec-Fetch-Mode: navigate",
    "--header",
    "Sec-Fetch-Site: none",
    "--header",
    "Sec-Fetch-User: ?1",
    ...(opts.extraArgs ?? []),
    ...(opts.resolves ?? []).flatMap((addr) => ["--resolve", `${u.hostname}:${port}:${addr}`]),
    "--",
    url,
  ];
}

export interface CurlResponse {
  status: number;
  contentType: string;
  text: string;
  /** Redirect target when the response is a 30x — followed (and validated) by curlGetText. */
  location: string | null;
}

/** Parse `-i` output into status, content type, and body. Pure; exported for tests.
 * Redirect chains (`--location`) emit one header block per hop — the final
 * response wins; each intermediate head is stripped. */
export function parseCurlResponse(raw: string): CurlResponse | null {
  let rest = raw;
  let status = 0;
  let contentType = "";
  for (;;) {
    const sep = headerEnd(rest);
    if (sep === -1) return null;
    const headerBlock = rest.slice(0, sep);
    const body = rest.slice(sep);
    // A hop boundary can leave a leading "\r\n" — the status line is the first
    // HTTP/… line in the block, not necessarily line 0.
    const statusLine = headerBlock.split("\n").map((l) => l.trim()).find((l) => /^HTTP\//i.test(l)) ?? "";
    const parsedStatus = Number.parseInt(statusLine.split(" ")[1] ?? "", 10);
    if (!Number.isFinite(parsedStatus)) return null;
    status = parsedStatus;
    contentType = /content-type:\s*(.+)/i.exec(headerBlock)?.[1]?.trim() ?? "";
    if (!/^\s*HTTP\//i.test(body)) {
      const location = /(^|\n)location:\s*(\S+)/i.exec(headerBlock)?.[2]?.trim() ?? null;
      return { status, contentType, text: body.replace(/^\s+/, ""), location };
    }
    rest = body; // redirect hop: strip this head, parse the next response
  }
}

/** Index just past the header block (first blank line), CRLF or LF. */
function headerEnd(s: string): number {
  const crlf = s.indexOf("\r\n\r\n");
  const lf = s.indexOf("\n\n");
  if (crlf === -1) return lf === -1 ? -1 : lf + 2;
  if (lf === -1) return crlf + 4;
  return Math.min(crlf + 4, lf + 2);
}

export interface CurlGetOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Fetch `url` via the best local curl binary with a Chrome browser profile.
 * Returns null when curl is unavailable, the scheme is not http(s), or the
 * transport fails — callers fall through. HTTP-level errors (4xx/5xx) are
 * returned, not thrown: the caller decides which statuses justify a retry.
 */
export async function curlGetText(url: string, opts: CurlGetOptions = {}): Promise<CurlResponse | null> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  if (current.protocol !== "https:" && current.protocol !== "http:") return null;

  const bin = await resolveCurlBinary();
  if (!bin) return null;

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const runOnce = (target: URL, resolves: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(
        bin,
        buildCurlArgs(target.href, { timeoutMs, resolves }),
        { timeout: timeoutMs + 5_000, maxBuffer: MAX_CURL_BYTES, signal: opts.signal },
        (err, stdout) => {
          // Exit code 28 = --max-time; 23/26 = write errors on huge bodies. A
          // timeout with partial stdout still carries the response head.
          if (err && !stdout) return resolve(null);
          resolve(String(stdout));
        },
      );
    });

  // Redirects are followed manually so every hop passes the shared SSRF guard.
  // Each hop's addresses are resolved once, validated, and pinned via --resolve:
  // curl performs no DNS of its own, so no rebinding window exists.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let addresses: string[];
    try {
      addresses = await resolveValidatedHost(current);
    } catch {
      return null; // blocked or unresolvable hop: caller keeps its fallback chain
    }
    const raw = await runOnce(current, addresses);
    if (raw === null) return null;
    const parsed = parseCurlResponse(raw);
    if (!parsed) return null;
    if (!parsed.location) return parsed;
    if (hop === MAX_REDIRECTS) return null;
    try {
      current = new URL(parsed.location, current);
    } catch {
      return null;
    }
  }
  return null;
}
