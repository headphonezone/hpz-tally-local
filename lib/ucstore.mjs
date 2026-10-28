// Local store for Unicommerce Sales vouchers: history (view / print) and every voucher number this
// app has issued, per Tally company. Same pattern as cnstore.mjs. The voucher number is always the
// Unicommerce invoice number, so this is a convenience index, not the source of truth for duplicates —
// Tally's own voucherNumbersOfType('Sales') is always checked fresh before posting.

import { currentUser } from './userstate.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'ucsales.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- One row per Sales voucher confirmed in Tally by read-back. Failed attempts write nothing.
  CREATE TABLE IF NOT EXISTS uc_sales (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_number  TEXT    NOT NULL,     -- = Unicommerce invoice number
    voucher_date    TEXT    NOT NULL,     -- YYYY-MM-DD
    company         TEXT    NOT NULL,
    sale_order_no   TEXT,
    customer_email  TEXT    NOT NULL,
    amount          REAL    NOT NULL,
    note            TEXT    NOT NULL,     -- JSON: lines, tax, charges (as computed and posted)
    test_mode       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL,
    UNIQUE (company, voucher_number)
  );
  CREATE INDEX IF NOT EXISTS idx_uc_sale_order ON uc_sales(sale_order_no);
`);

// Who posted it: the signed-in person ('local' on the single-PC open mode); NULL on rows from before accounts.
if (!db.prepare('PRAGMA table_info(uc_sales)').all().some((c) => c.name === 'created_by')) db.exec('ALTER TABLE uc_sales ADD COLUMN created_by TEXT');

const parse = (r) => r && ({ ...r, note: JSON.parse(r.note), test_mode: Boolean(r.test_mode) });

export function insertSale(s) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO uc_sales (voucher_number, voucher_date, company, sale_order_no, customer_email, amount, note, test_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    s.voucher_number, s.voucher_date, s.company, s.sale_order_no || null, s.customer_email, s.amount,
    JSON.stringify(s.note), s.test_mode ? 1 : 0, new Date().toISOString());
  db.prepare('UPDATE uc_sales SET created_by = ? WHERE id = ?').run(currentUser(), lastInsertRowid);
  return Number(lastInsertRowid);
}

// Numbers this app has issued in a company — added to Tally's own list before deciding what's new.
export function issuedNumbers(company) {
  return db.prepare('SELECT voucher_number FROM uc_sales WHERE company = ?').all(company).map((r) => r.voucher_number);
}

export function listSales({ q = '', from = '', to = '', limit = 200 } = {}) {
  const where = [], args = [];
  if (from) { where.push('voucher_date >= ?'); args.push(from); }
  if (to) { where.push('voucher_date <= ?'); args.push(to); }
  if (q) { where.push('(voucher_number LIKE ? OR sale_order_no LIKE ? OR customer_email LIKE ?)'); const l = `%${q}%`; args.push(l, l, l); }
  const sql = `SELECT * FROM uc_sales ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 1000)).map(parse);
}

export const getSale = (id) => parse(db.prepare('SELECT * FROM uc_sales WHERE id = ?').get(id));
