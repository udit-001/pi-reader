import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as cachedb from "./cachedb.ts";

export interface CacheMeta {
  url: string;
  mode: string;
  handler: string;
  kind: string;
  title?: string;
  fetchedAt: string; // ISO timestamp
  contentBytes: number;
  hasTree: boolean;
}

export interface CacheEntry {
  meta: CacheMeta;
  dir: string;
  contentPath: string;
  treePath?: string;
  ageHours: number;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$)/;

/**
 * One URL, one cache entry: drop fragments and tracking params, sort the query, lowercase the host, strip trailing slashes.
 * The canonical form is used both as the cache key and as the URL actually fetched.
 */
export function canonicalize(url: URL): string {
  const u = new URL(url.href);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = params.length ? `?${new URLSearchParams(params)}` : "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

/**
 * Human/model-legible layout: <root>/<host>/<path-slug>-<hash8>/
 * The slug lets the LLM ls/grep everything cached from a domain; the hash guarantees uniqueness.
 *
 * One directory per URL, whatever the mode.
 * A full fetch promotes the existing entry in place instead of writing a second copy of the same page.
 */
export function entryDir(root: string, url: string): string {
  const u = new URL(url);
  // The URL parser bans slashes in hostnames but allows "..", which would escape the cache root when joined.
  // Neutralize all-dot hostnames.
  const host = /^\.+$/.test(u.hostname) ? "invalid-host" : u.hostname;
  const hash8 = createHash("sha256").update(url).digest("hex").slice(0, 8);
  const slug =
    (u.pathname + u.search)
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "root";
  return join(root, host, `${slug}-${hash8}`);
}

/**
 * Full content is a superset of light, so a full entry answers a light request.
 * The reverse misses, and that miss is what triggers a promotion fetch.
 */
function satisfies(cached: string, wanted: string): boolean {
  return cached === wanted || cached === "full";
}

function toEntry(dir: string, meta: CacheMeta): CacheEntry {
  return {
    meta,
    dir,
    contentPath: join(dir, "content.md"),
    treePath: meta.hasTree ? join(dir, "tree") : undefined,
    ageHours: (Date.now() - Date.parse(meta.fetchedAt)) / 3_600_000,
  };
}

/** Union read: first fresh hit across the given roots (write-scope first). */
export function lookupAny(roots: string[], url: string, mode: string, ttlHours: number): CacheEntry | undefined {
  for (const root of roots) {
    const entry = lookup(root, url, mode, ttlHours);
    if (entry) return entry;
  }
  return undefined;
}

export function lookup(root: string, url: string, mode: string, ttlHours: number): CacheEntry | undefined {
  const dir = entryDir(root, url);
  try {
    const meta: CacheMeta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    if (!satisfies(meta.mode, mode)) return undefined;
    const entry = toEntry(dir, meta);
    if (entry.ageHours > ttlHours) return undefined;
    if (!existsSync(entry.contentPath)) return undefined;
    cachedb.touch(root, dir);
    return entry;
  } catch {
    return undefined;
  }
}

export function store(
  root: string,
  url: string,
  mode: string,
  data: { handler: string; kind: string; title?: string; content: string; hasTree: boolean },
): CacheEntry {
  const dir = entryDir(root, url);
  mkdirSync(dir, { recursive: true });
  // Demotion: a light entry has no tree, so an earlier clone in this dir goes.
  // Safe when a handler just wrote one, since hasTree is true in that case.
  // ponytail: a full fetch that throws before reaching here can leave a partial tree beside the old content; the next store or prune clears it.
  if (!data.hasTree) rmSync(join(dir, "tree"), { recursive: true, force: true });
  const meta: CacheMeta = {
    url,
    mode,
    handler: data.handler,
    kind: data.kind,
    title: data.title,
    fetchedAt: new Date().toISOString(),
    contentBytes: Buffer.byteLength(data.content, "utf8"),
    hasTree: data.hasTree,
  };
  writeFileSync(join(dir, "content.md"), data.content, "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  // Tree size is computed once here so stats never walk a clone again.
  const treeBytes = data.hasTree ? safeDirSize(join(dir, "tree")) : 0;
  cachedb.upsert(root, dir, meta, data.content, treeBytes);
  return toEntry(dir, meta);
}

export interface CacheStats {
  entries: number;
  bytes: number;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) total += dirSize(p);
    else total += statSync(p).size;
  }
  return total;
}

function safeDirSize(dir: string): number {
  try {
    return dirSize(dir);
  } catch {
    return 0;
  }
}

export function stats(root: string): CacheStats {
  const indexed = cachedb.stats(root);
  if (indexed) return indexed;
  if (!existsSync(root)) return { entries: 0, bytes: 0 };
  return { entries: walkEntries(root).length, bytes: safeDirSize(root) };
}

export function clear(root: string): void {
  cachedb.close(root); // release the sqlite file lock before deleting (Windows)
  rmSync(root, { recursive: true, force: true });
}

/** Filesystem walk: the source of truth. Used as fallback and by reindex. */
export function walkEntries(root: string): CacheEntry[] {
  if (!existsSync(root)) return [];
  const out: CacheEntry[] = [];
  for (const host of readdirSync(root, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    for (const d of readdirSync(join(root, host.name), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const dir = join(root, host.name, d.name);
        const meta: CacheMeta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        out.push(toEntry(dir, meta));
      } catch {
        // not a cache entry; skip
      }
    }
  }
  return out.sort((a, b) => a.ageHours - b.ageHours);
}

export function listEntries(root: string): CacheEntry[] {
  const indexed = cachedb.list(root);
  if (indexed) return indexed.map((e) => toEntry(e.dir, e.meta)).sort((a, b) => a.ageHours - b.ageHours);
  return walkEntries(root);
}

/**
 * Delete entries older than the ttl.
 * Returns how many were removed.
 * Walks the files rather than the index: deletion decisions read the source of truth.
 */
export function prune(root: string, ttlHours: number): number {
  const expired = walkEntries(root).filter((e) => e.ageHours > ttlHours);
  for (const e of expired) rmSync(e.dir, { recursive: true, force: true });
  cachedb.remove(root, expired.map((e) => e.dir));
  return expired.length;
}

/** LRU eviction down to a byte budget. Returns how many entries were removed. */
export function evictToBudget(root: string, maxBytes: number): number {
  const victims = cachedb.pickEvictions(root, maxBytes);
  for (const dir of victims) rmSync(dir, { recursive: true, force: true });
  cachedb.remove(root, victims);
  return victims.length;
}

export interface RecallHit {
  url: string;
  title: string;
  snippet: string;
  contentPath: string;
  dir: string;
}

/** BM25 full-text recall across roots. Null when no index is available (old Node). */
export function searchContent(roots: string[], query: string, limit = 10): RecallHit[] | null {
  const hits = cachedb.search(roots, query, limit);
  if (hits === null) return null;
  return hits.map((h) => ({
    url: h.url,
    title: h.title,
    snippet: h.snippet,
    contentPath: join(h.dir, "content.md"),
    dir: h.dir,
  }));
}

/**
 * Self-healing init: rebuild the index when it is corrupt, missing, or empty while entry files exist.
 * Returns what happened so the caller can notify.
 */
export function heal(root: string): "ok" | "rebuilt" | "skipped" {
  if (!existsSync(root) || !cachedb.available()) return "skipped";
  const hasDbFile = existsSync(join(root, "index.db"));
  if (hasDbFile && !cachedb.quickCheck(root)) {
    cachedb.close(root);
    for (const f of ["index.db", "index.db-wal", "index.db-shm"]) rmSync(join(root, f), { force: true });
  } else if (hasDbFile) {
    const indexed = cachedb.stats(root)?.entries ?? 0;
    if (indexed > 0 || walkEntries(root).length === 0) return "ok";
  }
  reindexRoot(root);
  return "rebuilt";
}

/** Rebuild a root's index from the files on disk. Returns entries indexed. */
export function reindexRoot(root: string): number {
  const entries = walkEntries(root).map((e) => {
    let content = "";
    try {
      content = readFileSync(e.contentPath, "utf8");
    } catch {
      // content missing; index metadata only
    }
    return {
      dir: e.dir,
      meta: e.meta,
      content,
      treeBytes: e.treePath ? safeDirSize(e.treePath) : 0,
    };
  });
  return cachedb.reindex(root, entries);
}
