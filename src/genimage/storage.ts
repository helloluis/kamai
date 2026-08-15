/**
 * Generated-image storage — SQLite metadata + filesystem blobs, with expiry.
 *
 * Mirrors src/screenshot/storage.ts deliberately (one storage pattern in this
 * codebase). Generated images are transient hand-offs: the calling app fetches
 * the bytes right away and keeps its own copy, so the default expiry is short
 * and the capacity ceiling small.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'genimages');
const DB_PATH = join(__dirname, '..', '..', 'data', 'genimages.db');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS genimages (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_genimages_expires ON genimages (expires_at);
`);

export interface GenImageRecord {
  id: string;
  owner: string;
  provider: string;
  model: string;
  size_bytes: number;
  file_path: string;
  created_at?: string;
  expires_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO genimages (id, owner, provider, model, size_bytes, file_path, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getByIdStmt = db.prepare(`SELECT * FROM genimages WHERE id = ?`);
// ISO-8601 comparison in JS, not against SQLite datetime('now') — see the
// identical note in screenshot/storage.ts.
const getExpiredStmt = db.prepare(`SELECT * FROM genimages WHERE expires_at < ?`);
const deleteByIdStmt = db.prepare(`DELETE FROM genimages WHERE id = ?`);
const sumAllStmt = db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM genimages`);

/** Small ceiling: images are fetched immediately and expire within a day. */
const MAX_TOTAL_BYTES = Number(process.env.GENIMAGE_MAX_TOTAL_GB ?? 2) * 1024 ** 3;

export function genImageCapacityOk(): boolean {
  return (sumAllStmt.get() as { n: number }).n < MAX_TOTAL_BYTES;
}

export function saveGenImage(rec: Omit<GenImageRecord, 'file_path' | 'created_at'>, buffer: Buffer): string {
  const filePath = join(DATA_DIR, `${rec.id}.png`);
  writeFileSync(filePath, buffer);
  insertStmt.run(rec.id, rec.owner, rec.provider, rec.model, buffer.length, filePath, rec.expires_at);
  return filePath;
}

/** Fetch a record, treating an expired one as absent (see screenshot note). */
export function getGenImage(id: string): GenImageRecord | null {
  const rec = (getByIdStmt.get(id) as GenImageRecord) ?? null;
  if (!rec) return null;
  const expires = Date.parse(rec.expires_at);
  if (!Number.isNaN(expires) && expires <= Date.now()) return null;
  return rec;
}

export function readGenImage(rec: GenImageRecord): Buffer | null {
  if (!existsSync(rec.file_path)) return null;
  return readFileSync(rec.file_path);
}

export function cleanupExpiredGenImages(): number {
  const expired = getExpiredStmt.all(new Date().toISOString()) as GenImageRecord[];
  for (const rec of expired) {
    try {
      if (existsSync(rec.file_path)) unlinkSync(rec.file_path);
    } catch { /* already gone */ }
    deleteByIdStmt.run(rec.id);
  }
  if (expired.length > 0) {
    console.log(`[GenImage] Cleaned up ${expired.length} expired image(s)`);
  }
  return expired.length;
}

export function closeGenImageDb(): void {
  db.close();
}
