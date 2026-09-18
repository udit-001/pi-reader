import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CacheMeta } from "./cache.ts";

/**
 * SQLite index over the file cache: fast listing, stats, hit tracking, LRU eviction, and FTS5 full-text recall.
 * Strictly an accelerator; the files on disk stay the source of truth and the index is rebuildable from them.
 * Every function here degrades to null/[] when sqlite is unavailable or the DB is broken, and callers fall back to filesystem walks.
 */

type DatabaseSync = InstanceType<typeof import("node:sqlite").DatabaseSync>;

let sqliteModule: typeof import("node:sqlite") | null | undefined;

function getSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    } catch {
      sqliteModule = null; // Node without node:sqlite; walk-based fallbacks take over
    }
  }
  return sqliteModule;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  dir TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  mode TEXT NOT NULL,
  handler TEXT,
  kind TEXT,
  title TEXT,
  fetchedAt TEXT,
  lastAccess INTEGER,
  hits INTEGER DEFAULT 0,
  contentBytes INTEGER DEFAULT 0,
  treeBytes INTEGER DEFAULT 0,
  hasTree INTEGER DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(url, title, content, dir UNINDEXED, tokenize='porter unicode61');
`;

const handles = new Map<string, DatabaseSync | null>();

/**
 * `create` is for the write paths only.
 * Reading must not conjure a cache: an install that has fetched nothing leaves no directory and no index file behind.
 */
function db(root: string, create = false): DatabaseSync | null {
  const cached = handles.get(root);
  if (cached !== undefined) return cached;
  if (!create && !existsSync(join(root, "index.db"))) return null;
  let d: DatabaseSync | null = null;
  const sq = getSqlite();
  if (sq) {
    try {
      mkdirSync(root, { recursive: true });
      d = new sq.DatabaseSync(join(root, "index.db"));
      d.exec("PRAGMA journal_mode=WAL");
      d.exec("PRAGMA busy_timeout=1000");
      d.exec(SCHEMA);
    } catch {
      try {
        d?.close(); // a half-opened handle would hold a file lock (Windows)
      } catch {
        // never opened
      }
      d = null;
    }
  }
  handles.set(root, d);
  return d;
}

/** Close and forget a root's handle. Required before deleting the cache dir on Windows. */
export function close(root: string): void {
  try {
    handles.get(root)?.close();
  } catch {
    // already closed or never opened
  }
  handles.delete(root);
}

/** Clean teardown: checkpoint WALs and release file locks on every open DB. */
export function closeAll(): void {
  for (const root of [...handles.keys()]) close(root);
}

/** True when the root's index passes SQLite's integrity check. */
export function quickCheck(root: string): boolean {
  const d = db(root);
  if (!d) return false;
  try {
    return (d.prepare("PRAGMA quick_check").get() as any)?.quick_check === "ok";
  } catch {
    return false;
  }
}

const FTS_CONTENT_CAP = 2 * 1024 * 1024;

export function upsert(root: string, dir: string, meta: CacheMeta, content: string, treeBytes: number): void {
  const d = db(root, true);
  if (!d) return;
  try {
    d.prepare(
      `INSERT OR REPLACE INTO entries (dir, url, mode, handler, kind, title, fetchedAt, lastAccess, hits, contentBytes, treeBytes, hasTree)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(dir, meta.url, meta.mode, meta.handler, meta.kind, meta.title ?? null, meta.fetchedAt, Date.now(), meta.contentBytes, treeBytes, meta.hasTree ? 1 : 0);
    d.prepare("DELETE FROM fts WHERE dir = ?").run(dir);
    d.prepare("INSERT INTO fts (url, title, content, dir) VALUES (?, ?, ?, ?)").run(
      meta.url,
      meta.title ?? "",
      content.slice(0, FTS_CONTENT_CAP),
      dir,
    );
  } catch {
    // index out of sync; reindex repairs it
  }
}

export function touch(root: string, dir: string): void {
  try {
    db(root)?.prepare("UPDATE entries SET lastAccess = ?, hits = hits + 1 WHERE dir = ?").run(Date.now(), dir);
  } catch {
    // best effort
  }
}

export function remove(root: string, dirs: string[]): void {
  const d = db(root);
  if (!d) return;
  try {
    const delEntry = d.prepare("DELETE FROM entries WHERE dir = ?");
    const delFts = d.prepare("DELETE FROM fts WHERE dir = ?");
    for (const dir of dirs) {
      delEntry.run(dir);
      delFts.run(dir);
    }
  } catch {
    // best effort
  }
}

export interface IndexedEntry {
  dir: string;
  meta: CacheMeta;
  treeBytes: number;
  lastAccess: number;
  hits: number;
}

function rowToEntry(r: any): IndexedEntry {
  return {
    dir: r.dir,
    meta: {
      url: r.url,
      mode: r.mode,
      handler: r.handler,
      kind: r.kind,
      title: r.title ?? undefined,
      fetchedAt: r.fetchedAt,
      contentBytes: Number(r.contentBytes),
      hasTree: !!r.hasTree,
    },
    treeBytes: Number(r.treeBytes),
    lastAccess: Number(r.lastAccess),
    hits: Number(r.hits),
  };
}

/** All entries, newest fetch first. Null when the index is unavailable. */
export function list(root: string): IndexedEntry[] | null {
  const d = db(root);
  if (!d) return null;
  try {
    return d.prepare("SELECT * FROM entries ORDER BY fetchedAt DESC").all().map(rowToEntry);
  } catch {
    return null;
  }
}

export function stats(root: string): { entries: number; bytes: number } | null {
  const d = db(root);
  if (!d) return null;
  try {
    const r = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(contentBytes + treeBytes), 0) AS b FROM entries").get() as any;
    return { entries: Number(r.n), bytes: Number(r.b) };
  } catch {
    return null;
  }
}

export interface SearchHit {
  dir: string;
  url: string;
  title: string;
  snippet: string;
  rank: number;
}

/** BM25-ranked full-text search across roots. Terms are quoted, so user input cannot break MATCH syntax. */
export function search(roots: string[], query: string, limit = 10): SearchHit[] | null {
  const match = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" ");
  if (!match) return [];
  let anyIndex = false;
  const hits: SearchHit[] = [];
  for (const root of roots) {
    const d = db(root);
    if (!d) continue;
    anyIndex = true;
    try {
      const rows = d
        .prepare(
          `SELECT dir, url, title, snippet(fts, 2, '>>', '<<', ' ... ', 16) AS snippet, bm25(fts, 2.0, 4.0, 1.0) AS rank
           FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit) as any[];
      hits.push(...rows.map((r) => ({ dir: r.dir, url: r.url, title: r.title ?? "", snippet: r.snippet ?? "", rank: Number(r.rank) })));
    } catch {
      // malformed index on this root; skip it
    }
  }
  if (!anyIndex) return null;
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

/** LRU eviction to a byte budget. Returns dirs the caller must delete from disk. */
export function pickEvictions(root: string, maxBytes: number): string[] {
  const d = db(root);
  if (!d) return [];
  try {
    const total = stats(root)?.bytes ?? 0;
    if (total <= maxBytes) return [];
    let excess = total - maxBytes;
    const victims: string[] = [];
    for (const r of d.prepare("SELECT dir, contentBytes + treeBytes AS b FROM entries ORDER BY lastAccess ASC").all() as any[]) {
      if (excess <= 0) break;
      victims.push(r.dir);
      excess -= Number(r.b);
    }
    return victims;
  } catch {
    return [];
  }
}

/** Rebuild the index from walked filesystem entries. */
export function reindex(root: string, entries: Array<{ dir: string; meta: CacheMeta; content: string; treeBytes: number }>): number {
  const d = db(root, entries.length > 0);
  if (!d) return 0;
  try {
    d.exec("DELETE FROM entries; DELETE FROM fts;");
    for (const e of entries) upsert(root, e.dir, e.meta, e.content, e.treeBytes);
    return entries.length;
  } catch {
    return 0;
  }
}

export function available(): boolean {
  return getSqlite() !== null;
}
