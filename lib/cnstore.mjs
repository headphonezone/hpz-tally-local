// Local store for Credit Notes (Goods Return): history (view / print) and every number this app has
// issued, per Tally company. Node's built-in SQLite, one file in data/ (gitignored) that survives
// restarts — keep it when moving the app to another PC.
//
// It does NOT decide what is credited: RMS (credit_note_no per returned item) and Tally (the credit
// notes themselves) do. Its numbers are only added to Tally's when picking the next order-N, so a
// number issued here is never handed out twice even if that voucher was later deleted in Tally.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'creditnote.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- One row per credit note confirmed in Tally by read-back. Failed attempts write nothing.
  CREATE TABLE IF NOT EXISTS credit_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_number  TEXT    NOT NULL,
    voucher_date    TEXT    NOT NULL,            -- YYYY-MM-DD
    company         TEXT    NOT NULL,
    order_no        TEXT    NOT NULL,
    party           TEXT    NOT NULL,
    invoice_no      TEXT,
    amount          REAL    NOT NULL,            -- party credit
    note            TEXT    NOT NULL,            -- JSON: lines, tax, COD, addresses (as computed and posted)
    rma_numbers     TEXT    NOT NULL,            -- JSON array: the RMS rows this credit note covers
    test_mode       INTEGER NOT NULL DEFAULT 0,  -- "Test — don't update RMS"
    rms_synced      INTEGER NOT NULL DEFAULT 0,
    rms_error       TEXT,
    created_at      TEXT    NOT NULL,
    UNIQUE (company, voucher_number)
  );
  CREATE INDEX IF NOT EXISTS idx_cn_order ON credit_notes(order_no);
`);

const parse = (r) => r && ({ ...r, note: JSON.parse(r.note), rma_numbers: JSON.parse(r.rma_numbers), test_mode: Boolean(r.test_mode), rms_synced: Boolean(r.rms_synced) });

export function insertCreditNote(c) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO credit_notes (voucher_number, voucher_date, company, order_no, party, invoice_no, amount, note, rma_numbers, test_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    c.voucher_number, c.voucher_date, c.company, String(c.order_no), c.party, c.invoice_no || null, c.amount,
    JSON.stringify(c.note), JSON.stringify(c.rma_numbers), c.test_mode ? 1 : 0, new Date().toISOString());
  return Number(lastInsertRowid);
}

export function markSynced(id, ok, error) {
  db.prepare('UPDATE credit_notes SET rms_synced = ?, rms_error = ? WHERE id = ?').run(ok ? 1 : 0, ok ? null : String(error || ''), id);
}

// Numbers this app has issued in a company (added to Tally's when choosing order-N).
export function issuedNumbers(company) {
  return db.prepare('SELECT voucher_number FROM credit_notes WHERE company = ?').all(company).map((r) => r.voucher_number);
}

export function listCreditNotes({ q = '', from = '', to = '', limit = 200 } = {}) {
  const where = [], args = [];
  if (from) { where.push('voucher_date >= ?'); args.push(from); }
  if (to) { where.push('voucher_date <= ?'); args.push(to); }
  if (q) { where.push('(voucher_number LIKE ? OR order_no LIKE ? OR party LIKE ? OR invoice_no LIKE ?)'); const l = `%${q}%`; args.push(l, l, l, l); }
  const sql = `SELECT * FROM credit_notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 1000)).map(parse);
}

export const getCreditNote = (id) => parse(db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(id));
