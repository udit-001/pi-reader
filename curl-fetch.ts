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
}

/** Build the full argv for one curl request. Pure; exported for tests. */
export function buildCurlArgs(url: string, opts: CurlArgsOptions = {}): string[] {
  const secs = Math.max(1, Math.round((opts.timeoutMs ?? 30_000) / 1000));
  return [
    "-sS",
    "--http2",
    "--compressed",
    "--location",
    "--max-redirs",
    "8",
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
    "--",
    url,
  ];
}

export interface CurlResponse {
  status: number;
  contentType: string;
  text: string;
}

/** Parse `-i` output into status line + headers + body. Pure; exported for tests. */
export function parseCurlResponse(raw: string): CurlResponse | null {
  const sep = raw.indexOf("\r\n\r\n");
  const sepAlt = raw.indexOf("\n\n");
  const splitAt = sep !== -1 ? sep + 4 : sepAlt !== -1 ? sepAlt + 2 : -1;
  if (splitAt === -1) return null;
  const headerBlock = raw.slice(0, splitAt);
  const body = raw.slice(splitAt);
  const statusLine = headerBlock.split("\n")[0]?.trim() ?? "";
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "", 10);
  if (!Number.isFinite(status)) return null;
  const contentType = /content-type:\s*(.+)/i.exec(headerBlock)?.[1]?.trim() ?? "";
  return { status, contentType, text: body };
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const bin = await resolveCurlBinary();
  if (!bin) return null;

  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    execFile(
      bin,
      buildCurlArgs(parsed.href, { timeoutMs }),
      { timeout: timeoutMs + 5_000, maxBuffer: MAX_CURL_BYTES, signal: opts.signal },
      (err, stdout) => {
        // Exit code 28 = --max-time; 23/26 = write errors on huge bodies. A
        // timeout with partial stdout still carries the response head.
        if (err && !stdout) return resolve(null);
        const parsedResponse = parseCurlResponse(String(stdout));
        if (!parsedResponse) return resolve(null);
        resolve(parsedResponse);
      },
    );
  });
}
