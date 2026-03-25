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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_browse_memories_domain ON browse_page_memories (domain);
`);

const stmtGet = db.prepare('SELECT id, domain, learning, created_at FROM browse_page_memories WHERE domain = ? ORDER BY created_at ASC');
const stmtAll = db.prepare('SELECT id, domain, learning, created_at FROM browse_page_memories ORDER BY domain, created_at ASC');
const stmtInsert = db.prepare('INSERT INTO browse_page_memories (domain, learning) VALUES (?, ?)');
const stmtDelete = db.prepare('DELETE FROM browse_page_memories WHERE id = ?');

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
  const { domain, learning } = req.body;
  if (!domain || !learning) {
    res.status(400).json({ ok: false, error: 'Missing "domain" and "learning"' });
    return;
  }
  const clean = cleanDomain(domain);
  const result = stmtInsert.run(clean, learning);
  console.log(`[Memory] Saved for ${clean}: "${(learning as string).slice(0, 80)}"`);
  res.status(201).json({ ok: true, id: result.lastInsertRowid, domain: clean, learning });
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

export function closeMemoriesDb(): void {
  db.close();
}

export default router;
