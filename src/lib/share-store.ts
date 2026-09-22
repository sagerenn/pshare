/**
 * SQLite-backed metadata store for shares. Each share records the OpenList
 * path it lives at, its media type, expiry, and download counters. The store
 * is intentionally tiny: a single `shares` table. OpenList holds the actual
 * file bytes; we hold the bookkeeping.
 */
import type { Database } from "better-sqlite3";

export type ShareType = "text" | "file" | "image" | "video" | "audio";

export type Share = {
  /** Short public id used in share URLs (/s/<id>). */
  id: string;
  /** Full logical path in OpenList, e.g. /pshare/abc/file.txt. */
  path: string;
  /** Original file name (for download headers and display). */
  name: string;
  /** Detected media type. */
  type: ShareType;
  /** MIME type from the upload, best-effort. */
  mime: string;
  /** Size in bytes. */
  size: number;
  /** Epoch ms when the share expires. */
  expires_at: number;
  /** Max downloads allowed before auto-delete (0 = unlimited). */
  max_downloads: number;
  /** Downloads served so far. */
  downloads: number;
  /** Epoch ms when the share was created. */
  created_at: number;
  /** Epoch ms when deleted (null while live). */
  deleted_at: number | null;
};

export type NewShare = Omit<Share, "downloads" | "created_at" | "deleted_at">;

let db: Database | null = null;

/** Open (or reuse) the SQLite database at dbPath and ensure the schema. */
export function openDb(dbPath: string, makeDb?: (path: string) => Database): Database {
  if (db) return db;
  // Lazy require so the native module is only loaded in the Node runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DatabaseCtor = (makeDb ?? require("better-sqlite3")) as new (path: string) => Database;
  const handle = new DatabaseCtor(dbPath);
  handle.pragma("journal_mode = WAL");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id            TEXT PRIMARY KEY,
      path          TEXT NOT NULL,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL,
      mime          TEXT NOT NULL,
      size          INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      max_downloads INTEGER NOT NULL DEFAULT 0,
      downloads     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      deleted_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
    CREATE INDEX IF NOT EXISTS idx_shares_deleted ON shares(deleted_at);
  `);
  db = handle;
  return handle;
}

/** Close and forget the open database. Used by tests. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Reset the module-level db handle without closing (for tests that pass a temp db). */
export function resetDbHandle(): void {
  db = null;
}

const COLS = "id, path, name, type, mime, size, expires_at, max_downloads, downloads, created_at, deleted_at";

function rowToShare(r: Record<string, unknown>): Share {
  return {
    id: r.id as string,
    path: r.path as string,
    name: r.name as string,
    type: r.type as ShareType,
    mime: r.mime as string,
    size: r.size as number,
    expires_at: r.expires_at as number,
    max_downloads: r.max_downloads as number,
    downloads: r.downloads as number,
    created_at: r.created_at as number,
    deleted_at: (r.deleted_at as number | null) ?? null,
  };
}

/** Insert a new share. */
export function createShare(db: Database, s: NewShare): Share {
  const now = Date.now();
  db.prepare(
    `INSERT INTO shares (${COLS}) VALUES (@id,@path,@name,@type,@mime,@size,@expires_at,@max_downloads,0,@now,NULL)`,
  ).run({ ...s, now });
  return { ...s, downloads: 0, created_at: now, deleted_at: null };
}

/** Fetch a live (non-deleted) share by id. */
export function getShare(db: Database, id: string): Share | null {
  const r = db.prepare(`SELECT ${COLS} FROM shares WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToShare(r) : null;
}

/**
 * Atomically claim one download against the limit. The UPDATE only increments
 * if the share is live AND not already at/over its limit (max_downloads = 0
 * means unlimited), so the check-and-increment is a single atomic step and
 * concurrent requests can't all squeeze past the limit.
 *
 * Returns the new download count on success, or -1 if the share is missing,
 * deleted, or already at its limit.
 */
export function incrementDownloads(db: Database, id: string): number {
  const info = db
    .prepare(
      `UPDATE shares
       SET downloads = downloads + 1
       WHERE id = ? AND deleted_at IS NULL
         AND (max_downloads = 0 OR downloads < max_downloads)`,
    )
    .run(id);
  if (info.changes === 0) return -1;
  const r = db.prepare("SELECT downloads FROM shares WHERE id = ?").get(id) as { downloads: number };
  return r.downloads;
}

/** Mark a share deleted (soft delete) without touching OpenList. */
export function markDeleted(db: Database, id: string): void {
  db.prepare("UPDATE shares SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Return all live shares that have expired or exceeded their download limit. */
export function listExpired(db: Database, now = Date.now()): Share[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM shares
       WHERE deleted_at IS NULL
         AND (expires_at <= ? OR (max_downloads > 0 AND downloads >= max_downloads))`,
    )
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToShare);
}

/** Return all live shares (for admin/debug listing). */
export function listLive(db: Database): Share[] {
  const rows = db.prepare(`SELECT ${COLS} FROM shares WHERE deleted_at IS NULL ORDER BY created_at DESC`).all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToShare);
}
