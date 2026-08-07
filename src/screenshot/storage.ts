/**
 * Screenshot storage — SQLite metadata + filesystem blobs, with expiry.
 *
 * Mirrors src/brochure/storage.ts deliberately: same shape, same cleanup
 * contract, so there is one storage pattern in this codebase rather than two.
 * Images are served from a PUBLIC unauthenticated download route (agents need
 * to hand the URL to a vision model), which is why the SSRF guard in
 * src/browser/urlGuard.ts re-checks after redirects.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'screenshots');
const DB_PATH = join(__dirname, '..', '..', 'data', 'screenshots.db');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    source_url TEXT NOT NULL,
    page_url TEXT,
    title TEXT,
    strategy TEXT NOT NULL,
    format TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_screenshots_wallet ON screenshots (wallet, created_at);
  CREATE INDEX IF NOT EXISTS idx_screenshots_expires ON screenshots (expires_at);
`);

export interface ScreenshotRecord {
  id: string;
  wallet: string;
  source_url: string;
  page_url: string | null;
  title: string | null;
  strategy: string;
  format: string;
  width: number;
  height: number;
  size_bytes: number;
  file_path: string;
  created_at?: string;
  expires_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO screenshots
    (id, wallet, source_url, page_url, title, strategy, format, width, height, size_bytes, file_path, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getByIdStmt = db.prepare(`SELECT * FROM screenshots WHERE id = ?`);
// expires_at is written as ISO-8601 ("2026-08-14T12:00:00.000Z"), which is NOT
// the shape SQLite's datetime('now') produces ("2026-08-14 12:00:00"). Compare
// against an ISO parameter so the sweep is a real comparison, not a lucky one
// that happens to work because 'T' sorts after ' '.
const getExpiredStmt = db.prepare(`SELECT * FROM screenshots WHERE expires_at < ?`);
const deleteByIdStmt = db.prepare(`DELETE FROM screenshots WHERE id = ?`);
const listByWalletStmt = db.prepare(
  `SELECT * FROM screenshots WHERE wallet = ? ORDER BY created_at DESC LIMIT 50`,
);

export function getFilePath(id: string, format: string): string {
  return join(DATA_DIR, `${id}.${format === 'png' ? 'png' : 'jpg'}`);
}

export function saveImage(id: string, buffer: Buffer, format: string): string {
  const filePath = getFilePath(id, format);
  writeFileSync(filePath, buffer);
  return filePath;
}

export function readImage(record: ScreenshotRecord): Buffer | null {
  if (!existsSync(record.file_path)) return null;
  return readFileSync(record.file_path);
}

export function insertScreenshot(rec: Omit<ScreenshotRecord, 'created_at'>): void {
  insertStmt.run(
    rec.id, rec.wallet, rec.source_url, rec.page_url, rec.title, rec.strategy,
    rec.format, rec.width, rec.height, rec.size_bytes, rec.file_path, rec.expires_at,
  );
}

/**
 * Fetch a record, treating an expired one as absent.
 *
 * The hourly sweep is not an access control: a 1-day capture stays on disk
 * until the next sweep, so without this check the image remained publicly
 * downloadable well past the expiry the API reported to the caller.
 * `expires_at` is stored as an ISO-8601 string, so it is compared in JS rather
 * than against SQLite's `datetime('now')` format, which is not the same shape.
 */
export function getScreenshot(id: string): ScreenshotRecord | null {
  const rec = (getByIdStmt.get(id) as ScreenshotRecord) ?? null;
  if (!rec) return null;
  const expires = Date.parse(rec.expires_at);
  if (!Number.isNaN(expires) && expires <= Date.now()) return null;
  return rec;
}

export function listScreenshots(wallet: string): ScreenshotRecord[] {
  return listByWalletStmt.all(wallet) as ScreenshotRecord[];
}

/** Delete expired screenshots from disk and database. Returns count deleted. */
export function cleanupExpiredScreenshots(): number {
  const expired = getExpiredStmt.all(new Date().toISOString()) as ScreenshotRecord[];
  for (const rec of expired) {
    try {
      if (existsSync(rec.file_path)) unlinkSync(rec.file_path);
    } catch { /* already gone */ }
    deleteByIdStmt.run(rec.id);
  }
  if (expired.length > 0) {
    console.log(`[Screenshot] Cleaned up ${expired.length} expired screenshot(s)`);
  }
  return expired.length;
}

export function closeScreenshotDb(): void {
  db.close();
}
