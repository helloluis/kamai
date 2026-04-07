/**
 * Brochure storage — SQLite metadata + filesystem for PDF files.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BrochureRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'brochures');
const DB_PATH = join(__dirname, '..', '..', 'data', 'brochures.db');

// Ensure directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create table
db.exec(`
  CREATE TABLE IF NOT EXISTS brochures (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    template TEXT NOT NULL,
    source_json TEXT NOT NULL,
    file_path TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 1,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_brochures_wallet ON brochures (wallet);
  CREATE INDEX IF NOT EXISTS idx_brochures_expires ON brochures (expires_at);
`);

// ─── Statements ───

const insertStmt = db.prepare(`
  INSERT INTO brochures (id, wallet, template, source_json, file_path, page_count, size_bytes, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = db.prepare(`SELECT * FROM brochures WHERE id = ?`);

const updateStmt = db.prepare(`
  UPDATE brochures SET source_json = ?, file_path = ?, page_count = ?, size_bytes = ?, expires_at = ?
  WHERE id = ?
`);

const getExpiredStmt = db.prepare(`SELECT * FROM brochures WHERE expires_at < datetime('now')`);

const deleteByIdStmt = db.prepare(`DELETE FROM brochures WHERE id = ?`);

const listByWalletStmt = db.prepare(`SELECT * FROM brochures WHERE wallet = ? ORDER BY created_at DESC LIMIT 50`);

// ─── Public API ───

export function getFilePath(id: string): string {
  return join(DATA_DIR, `${id}.pdf`);
}

export function savePdf(id: string, buffer: Buffer): string {
  const filePath = getFilePath(id);
  writeFileSync(filePath, buffer);
  return filePath;
}

export function readPdf(id: string): Buffer | null {
  const filePath = getFilePath(id);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath);
}

export function insertBrochure(record: Omit<BrochureRecord, 'created_at'>): void {
  insertStmt.run(
    record.id,
    record.wallet,
    record.template,
    record.source_json,
    record.file_path,
    record.page_count,
    record.size_bytes,
    record.expires_at,
  );
}

export function getBrochure(id: string): BrochureRecord | null {
  return (getByIdStmt.get(id) as BrochureRecord) ?? null;
}

export function updateBrochure(
  id: string,
  sourceJson: string,
  filePath: string,
  pageCount: number,
  sizeBytes: number,
  expiresAt: string,
): void {
  updateStmt.run(sourceJson, filePath, pageCount, sizeBytes, expiresAt, id);
}

export function listBrochures(wallet: string): BrochureRecord[] {
  return listByWalletStmt.all(wallet) as BrochureRecord[];
}

/** Delete expired brochures from disk and database. Returns count deleted. */
export function cleanupExpired(): number {
  const expired = getExpiredStmt.all() as BrochureRecord[];
  for (const rec of expired) {
    try {
      if (existsSync(rec.file_path)) unlinkSync(rec.file_path);
    } catch { /* file already gone */ }
    deleteByIdStmt.run(rec.id);
  }
  if (expired.length > 0) {
    console.log(`[Brochure] Cleaned up ${expired.length} expired brochure(s)`);
  }
  return expired.length;
}

export function closeBrochureDb(): void {
  db.close();
}