// COD Import tab: a courier's COD remittance file -> one Journal per AWB in Tally.
//
// HOW ACCOUNTS BOOK IT (read off the Headphone Zone company, 2026-10-22: 468 BlueDart journals of 8 Oct,
// for the remittance file Desktop\E-way bill automation\COD\Bluedart.csv, bank pay ref R22026100819247310):
//   Journal, one per AWB, narration = the AWB, dated the file's PAY REF DATE (the day BlueDart paid).
//   Cr the customer ledger (their e-mail)  — amount = the COD amount, bill "Agst Ref" = the order number.
//   Dr "COD Sales"                          — the same amount.
// The customer, the order number and the invoice value come from the Sales invoice that carries the AWB
// (BasicShipDocumentNo; the order number is its Reference, which is also its own "New Ref" bill name).
// Checked on all 468: 465 identical to the hand-made journals. The other 3 were knocked off against a
// DIFFERENT order of the same customer (e.g. 2,798 against the 2,398 bill) — the invoice's own bill is right.
//
// A row is postable only when exactly one live invoice carries the AWB, its value equals the file amount,
// and no Journal names the AWB yet (a cancelled one counts — it is never booked again from here).
//
// Formats: BlueDart only so far (the DTDC and Delhivery files are not known yet). Delhivery COD goes to
// "Delhivery COD Receivable" in the same company; add its column map to FORMATS when a file is available.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';
import { salesShipmentsForDay, journalsInRange, existingLedgers, importVouchers, maxVoucherNumber, ledgersBillWise } from './tally.mjs';

const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const money = (x) => round2(x).toFixed(2);
const isoOf = (y) => `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
const ymdOf = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');
const shiftDays = (y, n) => { const d = new Date(`${isoOf(y)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).replace(/-/g, ''); };
export const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '');
const fyStart = (y) => (+y.slice(4, 6) >= 4 ? `${y.slice(0, 4)}0401` : `${+y.slice(0, 4) - 1}0401`);

// --- local store: every journal posted from here, confirmed by read-back ----------------------------
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'cod.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, awb TEXT NOT NULL, courier TEXT NOT NULL,
    voucher_number TEXT, voucher_date TEXT, party TEXT, amount REAL, bill_ref TEXT, invoice TEXT,
    pay_ref TEXT, file_name TEXT, optional INTEGER NOT NULL DEFAULT 0, checks TEXT, created_at TEXT NOT NULL,
    UNIQUE (company, awb));
`);
function recordPosted(r) {
  db.prepare(`INSERT INTO posted (company, awb, courier, voucher_number, voucher_date, party, amount, bill_ref, invoice, pay_ref, file_name, optional, checks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company, awb) DO UPDATE SET voucher_number = excluded.voucher_number, voucher_date = excluded.voucher_date, party = excluded.party,
      amount = excluded.amount, bill_ref = excluded.bill_ref, invoice = excluded.invoice, pay_ref = excluded.pay_ref, file_name = excluded.file_name,
      optional = excluded.optional, checks = excluded.checks, created_at = excluded.created_at`)
    .run(r.company, r.awb, r.courier, r.voucher_number, r.voucher_date, r.party, r.amount, r.bill_ref, r.invoice, r.pay_ref, r.file_name,
      r.optional ? 1 : 0, JSON.stringify(r.checks || []), new Date().toISOString());
}
export const listPosted = (limit = 500) => db.prepare('SELECT * FROM posted ORDER BY id DESC LIMIT ?')
  .all(Math.min(Number(limit) || 500, 5000)).map((r) => ({ ...r, checks: JSON.parse(r.checks || '[]'), optional: Boolean(r.optional) }));
const postedHere = (company, awbs) => {
  const st = db.prepare('SELECT awb, voucher_number, voucher_date FROM posted WHERE company = ? AND awb = ?');
  return new Map(awbs.map((a) => [a, st.get(company, a)]).filter(([, r]) => r));
};

// --- the file ---------------------------------------------------------------------------------------
// Column headers are matched loosely ("AWBNO#", "AWB NO", …). Header row found by its AWB column, so the
// "Portal Name / Pan No / -----" lines BlueDart puts above it do not matter.
const FORMATS = [{
  courier: 'BLUEDART', label: 'BlueDart', drLedger: 'COD Sales',
  cols: {
    awb: /^AWB\s*NO/, amount: /^AMOUNT$/, ref: /^REF\s*NO/, pickup: /^P\s*\/?\s*U\s*DATE/, deposit: /^DEPOSIT\s*DATE/,
    payRef: /^BANK\s*PAY\s*REF/, payDate: /^PAY\s*REF\s*DATE/, orig: /^ORG\s*LOC/, dest: /^DST\s*LOC/,
  },
  needs: ['awb', 'amount', 'payRef', 'payDate'],
}];
export const COURIERS = Object.fromEntries(FORMATS.map((f) => [f.courier, { label: f.label, drLedger: f.drLedger }]));

function csvRows(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const out = []; let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; }
      else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    rows.push(out.map((s) => s.trim()));
  }
  return rows;
}

async function xlsxRows(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    for (let c = 1; c <= row.cellCount; c++) {
      let v = row.getCell(c).value;
      if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : '');
      vals.push(v instanceof Date ? v : String(v ?? '').trim());
    }
    rows.push(vals);
  });
  return rows;
}

const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
// "15-SEP-26", "15-Sep-2026", "15/09/2026", "2026-09-15" or an Excel date -> "2026-09-15" ('' if unreadable).
// A time after the date is ignored: BlueDart's file of 13-Oct-2026 wrote "21/09/2026 00:0" where the
// one of 8-Oct wrote "15-SEP-26". Unread, that pickup date made the invoice search miss 21 Sep.
function isoDate(v) {
  if (v instanceof Date) return Number.isNaN(+v) ? '' : v.toISOString().slice(0, 10);
  const s = String(v || '').trim().toUpperCase().replace(/[\sT]+\d{1,2}:\d{0,2}(:\d{0,2})?(\.\d+)?\s*(AM|PM)?$/, '');
  let m = /^(\d{1,2})[-/ ]([A-Z]{3})[A-Z]*[-/ ](\d{2,4})$/.exec(s);
  if (m && MON[m[2]]) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${String(MON[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// buf: the uploaded file. -> { courier, label, drLedger, rows: [{ awb, amount, ref, pickup, deposit, payRef, payDate, orig, dest }],
// duplicates, skipped, payRefs: [{ payRef, payDate, count, amount }] }
export async function parseFile(buf, name = '') {
  const isXlsx = buf[0] === 0x50 && buf[1] === 0x4b;   // "PK": a zip, i.e. .xlsx
  if (!isXlsx && buf[0] === 0xd0 && buf[1] === 0xcf) throw Object.assign(new Error('This is an old .xls file — open it in Excel and save it as .xlsx or .csv, then upload that.'), { status: 400 });
  const table = isXlsx ? await xlsxRows(buf) : csvRows(buf.toString('utf8'));
  const norm = (c) => String(c instanceof Date ? '' : c || '').toUpperCase().replace(/[#:.]/g, '').replace(/\s+/g, ' ').trim();
  for (const f of FORMATS) {
    const h = table.findIndex((r) => r.some((c) => f.cols.awb.test(norm(c))));
    if (h < 0) continue;
    const header = table[h].map(norm);
    const at = Object.fromEntries(Object.entries(f.cols).map(([k, re]) => [k, header.findIndex((c) => re.test(c))]));
    const lacking = f.needs.filter((k) => at[k] < 0);
    if (lacking.length) continue;
    const cell = (r, k) => (at[k] < 0 ? '' : r[at[k]] ?? '');
    const rows = [], seen = new Map(), duplicates = [];
    let skipped = 0;
    for (const r of table.slice(h + 1)) {
      const awb = String(cell(r, 'awb')).replace(/\s+/g, '');
      if (!/^\d{8,14}$/.test(awb)) { if (r.some((c) => String(c).trim() && !/^-+$/.test(String(c).trim()))) skipped++; continue; }
      const amount = round2(parseFloat(String(cell(r, 'amount')).replace(/[,₹\s]/g, '')) || 0);
      if (seen.has(awb)) { duplicates.push(awb); continue; }
      const row = { awb, amount, ref: String(cell(r, 'ref')), pickup: isoDate(cell(r, 'pickup')), deposit: isoDate(cell(r, 'deposit')),
        payRef: String(cell(r, 'payRef')), payDate: isoDate(cell(r, 'payDate')), orig: String(cell(r, 'orig')), dest: String(cell(r, 'dest')) };
      seen.set(awb, row); rows.push(row);
    }
    if (!rows.length) throw Object.assign(new Error(`No AWB rows found under the ${f.label} header in ${name || 'the file'}.`), { status: 400 });
    const byRef = new Map();
    for (const r of rows) {
      const k = `${r.payRef}|${r.payDate}`;
      const g = byRef.get(k) || byRef.set(k, { payRef: r.payRef, payDate: r.payDate, count: 0, amount: 0 }).get(k);
      g.count++; g.amount = round2(g.amount + r.amount);
    }
    return { courier: f.courier, label: f.label, drLedger: f.drLedger, rows, duplicates, skipped, payRefs: [...byRef.values()] };
  }
  throw Object.assign(new Error('This file is not a known COD format. Only the BlueDart COD remittance file (columns AWBNO#, AMOUNT, … BANK PAY REF NO, PAY REF DATE) is known so far — a DTDC or Delhivery file needs its format added first.'), { status: 400 });
}

// --- checking against Tally ------------------------------------------------------------------------
// Sales are read one day at a time (salesShipmentsForDay: ~1,000–2,000 invoices, 1–3 s a day; a month in
// one request ran this PC out of memory). The invoice is normally on or just before the pickup date, so the
// days [pickup − 7, pickup] are read first, and [pickup − 30, pickup − 8] only for AWBs still not found.
// Days already read stay in `cache` for 30 minutes, so a re-check after posting does not read them again.
const DAY_TTL = 30 * 60e3;
async function salesDays(days, cache, onProgress, label) {
  const todo = [...days].filter((d) => !(cache.get(d)?.at > Date.now() - DAY_TTL)).sort();
  let n = 0;
  for (const d of todo) {
    onProgress?.(`${label}: ${isoOf(d)} (${++n} of ${todo.length})`);
    cache.set(d, { at: Date.now(), vouchers: await salesShipmentsForDay(d) });
  }
}
function indexSales(days, cache, into) {
  for (const d of days) for (const v of cache.get(d)?.vouchers || []) {
    const a = String(v.awb || '').replace(/\s+/g, '');
    if (!a) continue;
    const list = into.get(a) || into.set(a, []).get(a);
    if (!list.some((x) => x.voucherNumber === v.voucherNumber && x.voucherType === v.voucherType)) list.push(v);
  }
}

// Every journal naming an AWB: narration tokens of 8–14 digits -> the journals. Plus the highest numeric
// Journal number seen (Journal numbering is manual in this company — Tally refuses a blank number).
async function journalIndex(fromYmd, toYmd, onProgress) {
  const byAwb = new Map(); let maxNo = 0;
  // Ten days a request: a month of journals in one read pushed this app's memory up by ~120 MB.
  for (let f = fromYmd; f <= toYmd;) {
    const t = shiftDays(f, 9) < toYmd ? shiftDays(f, 9) : toYmd;
    onProgress?.(`Reading journals ${isoOf(f)} – ${isoOf(t)}…`);
    for (const j of await journalsInRange(f, t)) {
      if (/^\d+$/.test(j.no)) maxNo = Math.max(maxNo, Number(j.no));
      const brief = { no: j.no, date: j.date, cancelled: j.cancelled, optional: j.optional };
      for (const a of String(j.narration).match(/\d{8,14}/g) || []) (byAwb.get(a) || byAwb.set(a, []).get(a)).push(brief);
    }
    f = shiftDays(t, 1);
  }
  return { byAwb, maxNo };
}

// How far back journals are read: from the earliest pickup (a COD journal is never older than the parcel),
// and at least 21 days, so the journal numbers in use lately are seen. Tally itself refuses a number that
// is taken (tried 2026-10-22), so a miss here stops the posting with an error; it never doubles a number.
const journalFrom = (rows) => {
  const today = todayYmd();
  const earliest = rows.map((r) => ymdOf(r.pickup)).filter(Boolean).sort()[0] || today;
  const from = [earliest, shiftDays(today, -21)].sort()[0];
  return from < fyStart(today) ? fyStart(today) : from;
};

export async function check(parsed, { company, fileName, cache, onProgress }) {
  const t0 = Date.now();
  const rows = parsed.rows.map((r) => ({ ...r }));
  const today = todayYmd();
  const ledgerOk = (await existingLedgers([parsed.drLedger])).has(parsed.drLedger);

  const { byAwb: journals, maxNo } = await journalIndex(journalFrom(rows), today, onProgress);
  const here = postedHere(company, rows.map((r) => r.awb));

  // Sales: the week up to each pickup, then a month further back for the ones not found.
  const span = (r, a, b) => { const p = ymdOf(r.pickup) || today; const out = []; for (let d = shiftDays(p, -a); d <= shiftDays(p, -b) && d <= today; d = shiftDays(d, 1)) out.push(d); return out; };
  const sales = new Map();
  const first = new Set(rows.flatMap((r) => span(r, 7, 0)));
  await salesDays(first, cache, onProgress, 'Reading sales invoices');
  indexSales(first, cache, sales);
  const lost = rows.filter((r) => !sales.has(r.awb) && !journals.has(r.awb));
  if (lost.length) {
    const more = new Set(lost.flatMap((r) => span(r, 30, 8)));
    await salesDays(more, cache, onProgress, `Looking further back for ${lost.length} AWB(s)`);
    indexSales(more, cache, sales);
  }

  for (const r of rows) classify(r, { journals, sales, here, ledgerOk, drLedger: parsed.drLedger });
  // Customers whose ledger keeps no bill-by-bill details: Tally drops an Agst Ref sent to them, so their
  // journal goes without one (as their invoice carries no New Ref either).
  const parties = [...new Set(rows.filter((r) => r.status === 'ready').map((r) => r.invoice.party))];
  if (parties.length) {
    onProgress?.(`Checking ${parties.length} customer ledgers…`);
    const billWise = await ledgersBillWise(parties);
    for (const r of rows) {
      if (r.status !== 'ready') continue;
      if (!billWise.has(r.invoice.party)) { r.problems.push(`customer ledger "${r.invoice.party}" is not in Tally`); r.status = 'blocked'; continue; }
      r.invoice.billWise = billWise.get(r.invoice.party);
      if (!r.invoice.billWise) r.notes.push('customer ledger does not track bills — posted without Agst Ref');
    }
  }
  return {
    builtAt: new Date().toISOString(), company, fileName, courier: parsed.courier, label: parsed.label, drLedger: parsed.drLedger,
    ledgerOk, payRefs: parsed.payRefs, duplicates: parsed.duplicates, skipped: parsed.skipped, maxJournalNo: maxNo,
    rows, counts: countRows(rows), total: round2(rows.reduce((s, r) => s + r.amount, 0)), tookMs: Date.now() - t0,
  };
}

function classify(r, { journals, sales, here, ledgerOk, drLedger }) {
  const js = journals.get(r.awb) || [];
  const live = js.filter((j) => !j.cancelled);
  const mine = here.get(r.awb);
  r.journal = (live[0] || js[0]) ? { no: (live[0] || js[0]).no, date: isoOf((live[0] || js[0]).date), cancelled: !live.length, optional: Boolean((live[0] || js[0]).optional), count: js.length }
    : mine ? { no: mine.voucher_number, date: isoOf(mine.voucher_date), cancelled: false, optional: false, count: 1, local: true } : null;
  const inv = sales.get(r.awb) || [];
  const liveInv = inv.filter((v) => !v.cancelled);
  const v = liveInv[0] || inv[0];
  r.invoice = v ? { no: v.voucherNumber, date: v.date, type: v.voucherType, party: v.party, reference: v.reference, value: round2(v.value), shippedBy: v.shippedBy, cancelled: !liveInv.length } : null;
  r.problems = []; r.notes = [];
  if (r.journal) { r.status = 'intally'; return; }
  if (!inv.length) r.problems.push('no sales invoice in Tally carries this AWB (searched 30 days before the pickup date)');
  else if (!liveInv.length) r.problems.push(`invoice ${v.voucherNumber} is cancelled in Tally`);
  else if (liveInv.length > 1) r.problems.push(`${liveInv.length} invoices carry this AWB: ${liveInv.map((x) => x.voucherNumber).join(', ')}`);
  else {
    if (Math.abs(v.value - r.amount) > 0.5) r.problems.push(`file amount ${money(r.amount)} ≠ invoice value ${money(v.value)}`);
    if (!v.party) r.problems.push(`invoice ${v.voucherNumber} has no party ledger`);
    if (!v.reference) r.problems.push(`invoice ${v.voucherNumber} has no order number (Reference) to knock off`);
    if (v.shippedBy && !/blue\s*dart/i.test(v.shippedBy)) r.notes.push(`invoice says shipped by ${v.shippedBy}`);
  }
  if (!(r.amount > 0)) r.problems.push('amount is zero');
  if (!r.pickup) r.problems.push('pickup date in the file could not be read');
  // The journal is dated the file's PAY REF DATE for this AWB (the day the courier paid), as accounts date them.
  if (!r.payDate) r.problems.push('pay ref date in the file could not be read — it is the journal date');
  else if (ymdOf(r.payDate) > todayYmd()) r.problems.push(`pay ref date ${r.payDate} is in the future`);
  if (!ledgerOk) r.problems.push(`ledger "${drLedger}" is not in this company`);
  r.status = r.problems.length ? 'blocked' : 'ready';
}

export function countRows(rows) {
  const c = { all: rows.length, ready: 0, intally: 0, blocked: 0, done: 0 };
  for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

// --- the voucher -----------------------------------------------------------------------------------
// Same shape and sign convention as the other vouchers here (Cr +, Dr −, isdeemedpositive explicit).
// Proven 2026-10-22 with a ₹1 Optional test journal, read back and deleted.
export function buildJournal({ number, date, row, drLedger, optional }) {
  const amt = money(row.amount);
  return {
    metadata: { type: 'Voucher', vchtype: 'Journal', action: 'Create', objview: 'Accounting Voucher View' },
    date, effectivedate: date, vouchertypename: 'Journal', vouchernumber: String(number),
    persistedview: 'Accounting Voucher View', ...(optional ? { isoptional: true } : {}),
    narration: row.awb,
    ledgerentries: [
      { ledgername: row.invoice.party, isdeemedpositive: false, ispartyledger: true, amount: amt,
        ...(row.invoice.billWise === false ? {} : { billallocations: [{ name: row.invoice.reference, billtype: 'Agst Ref', amount: amt }] }) },
      { ledgername: drLedger, isdeemedpositive: true, ispartyledger: false, amount: `-${amt}` },
    ],
  };
}

const replyErrors = (r) => {
  const list = [...(r?.error_list || []), ...(r?.data?.error_list || [])];
  const txt = list.map((e) => (typeof e === 'string' ? e : e?.error || e?.message || e?.line_error || '')).filter(Boolean);
  const res = r?.data?.import_result || r?.import_result || list.find((e) => e?.data?.import_result)?.data?.import_result;
  if (res && (Number(res.errors) || Number(res.exceptions))) txt.push(`Tally reported ${res.errors} error(s)${Number(res.exceptions) ? `, ${res.exceptions} exception(s)` : ''}`);
  return txt.join('; ');
};

// Post the chosen AWBs of a checked report, BATCH at a time: fresh duplicate check and journal numbers
// first, then each batch is read back from Tally (the proof is the read-back, not the import reply) and
// compared line by line. A batch with anything missing stops the run.
const BATCH = 25;
const yearMaxCache = { company: null, max: 0, at: 0 };
// The same Journal numbering serves every tab that posts Journals (COD, Payment Gateway): one cached year scan.
export async function yearMaxJournal(company, onProgress) {
  if (yearMaxCache.company === company && Date.now() - yearMaxCache.at < 30 * 60e3) return yearMaxCache.max;
  onProgress?.('Finding the next free Journal number — reading every journal number this year (about 2–3 minutes)…');
  const max = await maxVoucherNumber('Journal', fyStart(todayYmd()), todayYmd());
  Object.assign(yearMaxCache, { company, max, at: Date.now() });
  return max;
}
export const journalNumbersTaken = (company, upTo) => { if (yearMaxCache.company === company) yearMaxCache.max = Math.max(yearMaxCache.max, upTo); };
export const forgetJournalMax = () => { yearMaxCache.company = null; };
// Each journal is dated its own row's PAY REF DATE from the file. Batches never mix dates, so each one is
// read back from a single day.
export async function post(report, awbs, { optional = false, onProgress, log }) {
  const want = new Set(awbs);
  const today = todayYmd();
  onProgress?.({ message: 'Checking Tally for journals already naming these AWBs…' });
  const { byAwb, maxNo } = await journalIndex(journalFrom(report.rows.filter((r) => want.has(r.awb))), today, (m) => onProgress?.({ message: m }));
  const here = postedHere(report.company, [...want]);
  const todo = [], skipped = [];
  for (const r of report.rows) {
    if (!want.has(r.awb)) continue;
    if (r.status !== 'ready') { skipped.push(`${r.awb}: ${r.status}`); continue; }
    if (byAwb.has(r.awb) || here.has(r.awb)) {
      const j = byAwb.get(r.awb)?.[0];
      r.status = 'intally';
      r.journal = j ? { no: j.no, date: isoOf(j.date), cancelled: j.cancelled, optional: j.optional, count: byAwb.get(r.awb).length } : { no: here.get(r.awb).voucher_number, date: isoOf(here.get(r.awb).voucher_date), local: true };
      skipped.push(`${r.awb}: already in Tally`);
      continue;
    }
    todo.push(r);
  }
  todo.sort((a, b) => a.payDate.localeCompare(b.payDate));
  const batches = [];
  for (const r of todo) {
    const last = batches[batches.length - 1];
    if (last && last.length < BATCH && last[0].payDate === r.payDate) last.push(r); else batches.push([r]);
  }
  // Next number: the highest in the WHOLE financial year — numbers follow entry order, and back-dated
  // journals carry recent numbers (1200435 was dated 28-Sep). Tally refuses a taken number anyway.
  // The year scan takes ~2.5 min, so it is kept 30 min per company; a refused batch drops it.
  let yearMax = yearMaxCache.company === report.company && Date.now() - yearMaxCache.at < 30 * 60e3 ? yearMaxCache.max : null;
  if (yearMax === null) {
    onProgress?.({ message: 'Finding the next free Journal number — reading every journal number this year (about 2–3 minutes)…' });
    yearMax = await maxVoucherNumber('Journal', fyStart(today), today);
    Object.assign(yearMaxCache, { company: report.company, max: yearMax, at: Date.now() });
  }
  let next = Math.max(maxNo, yearMax, Number(report.maxJournalNo) || 0) + 1;
  const result = { posted: 0, failed: 0, skipped, errors: [], firstNo: null, lastNo: null, dates: {} };
  let i = 0;
  for (const rows of batches) {
    const date = ymdOf(rows[0].payDate);
    const batch = rows.map((row) => ({ row, number: next++ }));
    onProgress?.({ message: `Posting ${i + 1}–${i + batch.length} of ${todo.length} (dated ${rows[0].payDate})…`, done: i, total: todo.length });
    i += batch.length;
    const vouchers = batch.map(({ row, number }) => buildJournal({ number, date, row, drLedger: report.drLedger, optional }));
    let reply;
    try { reply = await importVouchers(vouchers); } catch (err) { reply = { error_list: [err.message] }; }
    log?.(`COD batch ${batch[0].number}-${batch[batch.length - 1].number}`, vouchers, reply);
    const back = new Map();
    for (const j of await journalsInRange(date, date, { lines: true })) if (!j.cancelled) (back.get(j.narration.trim()) || back.set(j.narration.trim(), []).get(j.narration.trim())).push(j);
    let missing = 0;
    for (const { row, number } of batch) {
      const found = (back.get(row.awb) || []).find((j) => j.no === String(number)) || (back.get(row.awb) || [])[0];
      if (!found) { missing++; result.failed++; row.postError = 'not found in Tally after import'; continue; }
      const checks = [];
      const cr = found.lines.find((l) => l.amount > 0), dr = found.lines.find((l) => l.amount < 0);
      if (found.no !== String(number)) checks.push(`numbered ${found.no}, sent ${number}`);
      if (cr?.ledger !== row.invoice.party) checks.push(`Cr ledger is ${cr?.ledger || 'missing'}`);
      if (Math.abs((cr?.amount || 0) - row.amount) > 0.005) checks.push(`amount is ${cr?.amount}`);
      if (row.invoice.billWise !== false && (cr?.bills?.[0]?.name !== row.invoice.reference || cr?.bills?.[0]?.type !== 'Agst Ref')) checks.push(`bill is ${cr?.bills?.[0]?.name || 'missing'} ${cr?.bills?.[0]?.type || ''}`.trim());
      if (dr?.ledger !== report.drLedger) checks.push(`Dr ledger is ${dr?.ledger || 'missing'}`);
      if (found.optional !== Boolean(optional)) checks.push(found.optional ? 'Optional in Tally' : 'regular in Tally, sent as Optional');
      row.status = 'done';
      row.journal = { no: found.no, date: isoOf(found.date), optional: found.optional, count: 1, checks };
      recordPosted({ company: report.company, awb: row.awb, courier: report.courier, voucher_number: found.no, voucher_date: found.date,
        party: row.invoice.party, amount: row.amount, bill_ref: row.invoice.reference, invoice: row.invoice.no, pay_ref: row.payRef,
        file_name: report.fileName, optional, checks });
      result.posted++;
      result.dates[row.payDate] = (result.dates[row.payDate] || 0) + 1;
      result.firstNo ??= found.no; result.lastNo = found.no;
      if (checks.length) result.errors.push(`${row.awb} (${found.no}): ${checks.join('; ')}`);
    }
    if (yearMaxCache.company === report.company) yearMaxCache.max = Math.max(yearMaxCache.max, next - 1);   // our own numbers are taken now
    if (missing) {
      yearMaxCache.company = null;   // a number may have been taken: scan the year again next time
      const why = replyErrors(reply);
      result.errors.unshift(`${missing} of ${batch.length} in the batch from ${batch[0].number} were not posted${why ? ` — ${why}` : ''}. Stopped; nothing after them was sent.`);
      break;
    }
  }
  report.counts = countRows(report.rows);
  return result;
}
