/**
 * Domain memories routes — legacy compatibility + new API.
 *
 * GET  /browse/memories?domain=...  — get learnings for a domain
 * POST /browse/memories             — save a learning
 * DELETE /browse/memories/:id       — delete a learning
 */
import { Router } from 'express';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', '..', '..', 'browse_memories.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS browse_page_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    learning TEXT NOT NULL,
    strategy TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_browse_memories_domain ON browse_page_memories (domain);
`);

// Add strategy column if missing (migration for existing DBs)
try {
  db.exec('ALTER TABLE browse_page_memories ADD COLUMN strategy TEXT DEFAULT NULL');
} catch {
  // Column already exists
}

const stmtGet = db.prepare('SELECT id, domain, learning, strategy, created_at FROM browse_page_memories WHERE domain = ? ORDER BY created_at ASC');
const stmtAll = db.prepare('SELECT id, domain, learning, strategy, created_at FROM browse_page_memories ORDER BY domain, created_at ASC');
const stmtInsert = db.prepare('INSERT INTO browse_page_memories (domain, learning, strategy) VALUES (?, ?, ?)');
const stmtDelete = db.prepare('DELETE FROM browse_page_memories WHERE id = ?');
const stmtGetStrategy = db.prepare('SELECT strategy FROM browse_page_memories WHERE domain = ? AND strategy IS NOT NULL LIMIT 1');

function cleanDomain(d: string): string {
  return d.replace(/^www\./, '').toLowerCase();
}

const router = Router();

router.get('/', (req, res) => {
  const domain = req.query.domain as string | undefined;
  if (domain) {
    const memories = stmtGet.all(cleanDomain(domain));
    res.json({ ok: true, domain: cleanDomain(domain), memories });
  } else {
    const all = stmtAll.all();
    res.json({ ok: true, memories: all });
  }
});

router.post('/', (req, res) => {
  const { domain, learning, strategy } = req.body;
  if (!domain || !learning) {
    res.status(400).json({ ok: false, error: 'Missing "domain" and "learning"' });
    return;
  }
  const clean = cleanDomain(domain);
  const result = stmtInsert.run(clean, learning, strategy || null);
  const strategyTag = strategy ? ` [strategy: ${strategy}]` : '';
  console.log(`[Memory] Saved for ${clean}: "${(learning as string).slice(0, 80)}"${strategyTag}`);
  res.status(201).json({ ok: true, id: result.lastInsertRowid, domain: clean, learning, strategy: strategy || null });
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ ok: false, error: 'Invalid ID' });
    return;
  }
  stmtDelete.run(id);
  res.json({ ok: true, deleted: id });
});

/** Look up memories for a URL's domain (used by the browse route). */
export function getMemoriesForDomain(url: string): string[] {
  try {
    const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
    const rows = stmtGet.all(hostname) as { learning: string }[];
    return rows.map((r) => r.learning);
  } catch {
    return [];
  }
}

/** Look up strategy override for a URL's domain. Returns null if no strategy set. */
export function getStrategyForDomain(url: string): string | null {
  try {
    const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
    const row = stmtGetStrategy.get(hostname) as { strategy: string } | undefined;
    return row?.strategy ?? null;
  } catch {
    return null;
  }
}

export function closeMemoriesDb(): void {
  db.close();
}

export default router;
