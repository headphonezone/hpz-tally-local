// Local store for Stock Journals: history, the RMS-N series, and the duplicate rule. Uses Node's
// built-in SQLite (node:sqlite), so there is nothing to install and the whole store is one file in
// data/ (gitignored). This app owns the series; Tally is never asked for the next number.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'stockjournal.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- One row per voucher confirmed in Tally by read-back. Failed attempts write nothing, so a
  -- failure never consumes a number.
  CREATE TABLE IF NOT EXISTS journals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    seq             INTEGER NOT NULL UNIQUE,
    voucher_number  TEXT    NOT NULL UNIQUE,
    voucher_date    TEXT    NOT NULL,            -- YYYY-MM-DD
    company         TEXT    NOT NULL,            -- the Tally company it was posted into
    from_godown     TEXT    NOT NULL,
    to_godown       TEXT    NOT NULL,
    unboxed         INTEGER NOT NULL,
    narration       TEXT    NOT NULL,
    refs            TEXT    NOT NULL,            -- JSON array
    lines           TEXT    NOT NULL,            -- JSON [{item, qty}], aggregated as posted
    total_qty       REAL    NOT NULL,
    created_at      TEXT    NOT NULL,
    rms_synced      INTEGER NOT NULL DEFAULT 0,  -- written back to RMS?
    rms_error       TEXT
  );

  -- One row per (reference, item) before aggregation: which return contributed which item. This is
  -- what makes the duplicate rule answerable later.
  CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    journal_id   INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
    reference    TEXT    NOT NULL,
    item         TEXT    NOT NULL,
    rma_number   TEXT,
    qty          REAL    NOT NULL,
    from_godown  TEXT    NOT NULL,
    to_godown    TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_dupe ON entries(reference, item, from_godown, to_godown);
  CREATE INDEX IF NOT EXISTS idx_entries_ref  ON entries(reference, item);
`);

const parse = (row) => row && ({
  ...row,
  unboxed: Boolean(row.unboxed),
  rms_synced: Boolean(row.rms_synced),
  refs: JSON.parse(row.refs),
  lines: JSON.parse(row.lines),
});

// The next number: one past the highest used, and never below the configured start. The start
// exists because RMS-1 to RMS-6 were already posted to Tally before this store existed.
export function nextSeq(seriesStart) {
  const { m } = db.prepare('SELECT MAX(seq) AS m FROM journals').get();
  return Math.max((m ?? 0) + 1, seriesStart);
}

// Duplicate rule: blocked only when reference + item + from + to ALL match an earlier posting.
// A multi-item return can be split across journals, and an item can move on to another pair of
// godowns later; only a true repeat of the same movement is refused.
export function findDuplicates(entries, fromGodown, toGodown) {
  const stmt = db.prepare(`
    SELECT e.reference, e.item, j.voucher_number, j.voucher_date
      FROM entries e JOIN journals j ON j.id = e.journal_id
     WHERE e.reference = ? AND e.item = ? AND e.from_godown = ? AND e.to_godown = ?`);
  const out = [];
  for (const e of entries) out.push(...stmt.all(e.reference, e.item, fromGodown, toGodown));
  return out;
}

// Where an item of a reference has been posted before, for display while picking.
export function postedBefore(reference, item) {
  return db.prepare(`
    SELECT j.voucher_number, j.voucher_date, e.from_godown, e.to_godown
      FROM entries e JOIN journals j ON j.id = e.journal_id
     WHERE e.reference = ? AND e.item = ?
     ORDER BY j.seq`).all(reference, item);
}

export function insertJournal(j, entries) {
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO journals (seq, voucher_number, voucher_date, company, from_godown, to_godown, unboxed,
                            narration, refs, lines, total_qty, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      j.seq, j.voucher_number, j.voucher_date, j.company, j.from_godown, j.to_godown, j.unboxed ? 1 : 0,
      j.narration, JSON.stringify(j.refs), JSON.stringify(j.lines), j.total_qty, new Date().toISOString());
    const ins = db.prepare(`
      INSERT INTO entries (journal_id, reference, item, rma_number, qty, from_godown, to_godown)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const e of entries) ins.run(lastInsertRowid, e.reference, e.item, e.rma_number || null, e.qty, j.from_godown, j.to_godown);
    db.exec('COMMIT');
    return Number(lastInsertRowid);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function markSynced(id, ok, error) {
  db.prepare('UPDATE journals SET rms_synced = ?, rms_error = ? WHERE id = ?').run(ok ? 1 : 0, ok ? null : String(error || ''), id);
}

export function listJournals({ q = '', from = '', to = '', limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('voucher_date >= ?'); args.push(from); }
  if (to) { where.push('voucher_date <= ?'); args.push(to); }
  if (q) {
    where.push(`(voucher_number LIKE ? OR narration LIKE ? OR id IN (SELECT journal_id FROM entries WHERE reference LIKE ? OR item LIKE ?))`);
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const sql = `SELECT * FROM journals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 1000)).map(parse);
}

export function getJournal(id) {
  const j = parse(db.prepare('SELECT * FROM journals WHERE id = ?').get(id));
  if (!j) return null;
  j.entries = db.prepare('SELECT reference, item, rma_number, qty FROM entries WHERE journal_id = ? ORDER BY id').all(id);
  return j;
}
