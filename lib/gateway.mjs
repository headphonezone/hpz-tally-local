// Payment Gateway tab: a gateway settlement report (Razorpay / Cashfree, uploaded as Excel) compared with the
// Shopify orders (read through the API, lib/shopify.mjs), and the Journal rows that come out of it.
//
// Ported from the old Streamlit tool (repo Razorpay-Cashfree-Shopify_Automation, Razorpay.py / CashFree.py). The
// journal format is unchanged:
//   a payment:  Cr customer e-mail,  Dr "<Gateway> Payment Receivable"   (Debit Reference No = the Shopify order number)
//   a refund:   Cr "<Gateway> Payment Receivable", Dr customer e-mail
//   Razorpay also gets one commission journal for the whole report: Cr Receivable, Dr "Razorpay Commission Paid",
//   amount = fee (exclusive tax) + tax, summed over every row of the report.
// Dated the gateway's settlement date.
//
// What changed from the old tool: Shopify comes from the API, not an export; Cashfree rows are matched on the
// gateway reference first and on e-mail + amount after, instead of e-mail alone (a customer with two orders got
// the first one's number); and every row is also compared in amount with the Shopify payment it was matched to.

import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

export const GATEWAYS = {
  razorpay: { label: 'Razorpay', receivable: 'Razorpay Payment Receivable', commission: 'Razorpay Commission Paid' },
  cashfree: { label: 'Cashfree', receivable: 'Cashfree Receivable', commission: 'Cashfree Commission Paid' },
};

// --- reading the Excel -------------------------------------------------------------------------------
const plain = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
  }
  return v;
};
const lc = (v) => String(v ?? '').trim().toLowerCase();

// A long text cell (Razorpay's payment_notes / order_notes run to thousands of characters per row) is never one of
// the columns used, so it is dropped on the way in: an 8 MB report would otherwise need most of a gigabyte.
const slim = (v) => (typeof v === 'string' && v.length > 300 ? '' : v);

export async function readRows(buf, name = '') {
  const grid = [];
  if (/\.csv$/i.test(name)) {
    const wb = new ExcelJS.Workbook();
    await wb.csv.read(Readable.from([Buffer.from(buf)]));
    const ws = wb.worksheets[0];
    if (!ws) throw Object.assign(new Error('The file has no sheet'), { status: 400 });
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (c, i) => { cells[i - 1] = slim(plain(c.value)); });
      grid.push(cells);
    });
    return grid;
  }
  try {
    const rd = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([Buffer.from(buf)]), { sharedStrings: 'cache', worksheets: 'emit', styles: 'ignore', hyperlinks: 'ignore' });
    for await (const ws of rd) {
      for await (const row of ws) grid.push(row.values.slice(1).map((v) => slim(plain(v))));
      return grid;   // the first sheet only
    }
  } catch { grid.length = 0; /* a zip layout the streaming reader cannot follow: read it whole instead */ }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('The file has no sheet'), { status: 400 });
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c, i) => { cells[i - 1] = slim(plain(c.value)); });
    grid.push(cells);
  });
  return grid;
}

// The header row is the first of the top 100 rows that holds at least two of the anchor names: the gateway's
// reports carry summary lines above it.
export function tableFrom(grid, anchors) {
  const want = anchors.map(lc);
  let at = -1;
  for (let i = 0; i < Math.min(grid.length, 100) && at < 0; i++) {
    const vals = (grid[i] || []).filter((v) => v != null && v !== '').map(lc);
    if (want.filter((a) => vals.some((v) => v.includes(a))).length >= 2) at = i;
  }
  if (at < 0) return null;
  const head = (grid[at] || []).map((h) => String(h ?? '').trim());
  const rows = [];
  for (const r of grid.slice(at + 1)) {
    if (!r || !r.some((v) => v != null && v !== '')) continue;
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = r[i] ?? null; });
    rows.push(o);
  }
  return { head, rows };
}

// The column called exactly `want` (any case), else the first whose name contains it.
const col = (head, want) => head.find((h) => lc(h) === lc(want)) || head.find((h) => lc(h).includes(lc(want))) || null;

export function money(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// A date cell as yyyy-mm-dd: a real Excel date, or text as ISO, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy or "28 Oct 2026".
export function dateOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/))) return iso(m[3], m[2], m[1]);
  if ((m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{4})/)) && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return null;
}

const missingCols = (head, need) => need.filter((n) => !col(head, n));
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

// --- Razorpay ----------------------------------------------------------------------------------------
const RP_ANCHORS = ['transaction_entity', 'order_receipt', 'settled_at'];
const RP_NEED = ['transaction_entity', 'order_receipt', 'settled_at', 'credit', 'amount', 'fee (exclusive tax)', 'tax'];
const RP_SKIP = new Set(['settlement.ondemand', 'adjustment']);

export function parseRazorpay(grid) {
  const t = tableFrom(grid, RP_ANCHORS);
  if (!t) throw fail('This does not look like a Razorpay settlement report (no row with transaction_entity / order_receipt / settled_at).');
  const lost = missingCols(t.head, RP_NEED);
  if (lost.length) throw fail(`The Razorpay report has no column: ${lost.join(', ')}.`);
  const c = Object.fromEntries(RP_NEED.map((n) => [n, col(t.head, n)]));
  const entities = {};
  let fee = 0, tax = 0, lastDate = null;
  const rows = [];
  for (const r of t.rows) {
    const entity = lc(r[c.transaction_entity]);
    entities[entity || '(blank)'] = (entities[entity || '(blank)'] || 0) + 1;
    fee += money(r[c['fee (exclusive tax)']]); tax += money(r[c.tax]);
    const d = dateOf(r[c.settled_at]);
    if (d && (!lastDate || d > lastDate)) lastDate = d;
    if (RP_SKIP.has(entity)) continue;
    rows.push({
      kind: money(r[c.credit]) > 0 ? 'payment' : 'refund',
      date: d,
      ref: String(r[c.order_receipt] ?? '').trim(),
      amount: round2(Math.abs(money(r[c.amount]))),
      entity,
    });
  }
  return { gateway: 'razorpay', rows, commission: round2(fee + tax), commissionDate: lastDate, entities };
}

// --- Cashfree ----------------------------------------------------------------------------------------
const CF_NEED = ['Event Type', 'Sale Type', 'Customer Email', 'Event Amount', 'Merchant Reference Id', 'Settlement Date'];

export function parseCashfree(grid) {
  const t = tableFrom(grid, CF_NEED);
  if (!t) throw fail('This does not look like a Cashfree settlement report (no row with Event Type / Sale Type / Customer Email …).');
  const lost = missingCols(t.head, CF_NEED);
  if (lost.length) throw fail(`The Cashfree report has no column: ${lost.join(', ')}.`);
  const c = Object.fromEntries(CF_NEED.map((n) => [n, col(t.head, n)]));
  const entities = {};
  const rows = [];
  for (const r of t.rows) {
    const type = String(r[c['Event Type']] ?? '').trim().toUpperCase();
    entities[type || '(blank)'] = (entities[type || '(blank)'] || 0) + 1;
    if (type !== 'PAYMENT' && type !== 'REFUND') continue;
    rows.push({
      kind: String(r[c['Sale Type']] ?? '').trim().toUpperCase() === 'CREDIT' ? 'payment' : 'refund',
      date: dateOf(r[c['Settlement Date']]),
      ref: String(r[c['Merchant Reference Id']] ?? '').trim(),
      email: String(r[c['Customer Email']] ?? '').trim(),
      amount: round2(Math.abs(money(r[c['Event Amount']]))),
      entity: type.toLowerCase(),
    });
  }
  return { gateway: 'cashfree', rows, commission: 0, commissionDate: null, entities };
}

export async function parseFile(gateway, buf, name) {
  if (!GATEWAYS[gateway]) throw fail(`Unknown gateway "${gateway}"`);
  let grid;
  try { grid = await readRows(buf, name); }
  catch (err) { throw err.status ? err : fail(`Could not read the file: ${err.message}`); }
  return gateway === 'razorpay' ? parseRazorpay(grid) : parseCashfree(grid);
}

// The Shopify date range the report needs: a payment is settled some days after the order was placed.
export const LOOKBACK_DAYS = 15;
const shiftIso = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function shopifyRange(parsed) {
  const ds = parsed.rows.map((r) => r.date).filter(Boolean).sort();
  if (!ds.length) return null;
  return { from: shiftIso(ds[0], -LOOKBACK_DAYS), to: ds[ds.length - 1] };
}

// A Shopify payment id: "r" and 24 letters/digits. Refund rows of an old order carry one too.
const SHOPIFY_REF = /^r[A-Za-z0-9]{24}$/;

// Read the Shopify orders a report needs and match them: the date range first, then (for rows still not found whose
// reference is a Shopify payment id) a direct search by payment id, which reaches orders of any age. `shopify` is
// lib/shopify.mjs, passed in so the match itself stays testable without the network.
export async function reconcile(gateway, parsed, shopify, { onProgress, maxLookups = 400 } = {}) {
  const range = shopifyRange(parsed);
  if (!range) throw new Error('No dates could be read from the report, so the Shopify orders cannot be chosen.');
  let orders = await shopify.fetchOrders(range.from, range.to, { onProgress });
  let rows = match(parsed, shopify.indexOrders(orders));
  const lost = [...new Set(rows.filter((r) => r.status === 'unmatched' && SHOPIFY_REF.test(r.ref)).map((r) => r.ref))].slice(0, maxLookups);
  let older = 0;
  if (lost.length) {
    const seen = new Set(orders.map((o) => o.id));
    const extra = (await shopify.fetchByPaymentIds(lost, { onProgress })).filter((o) => !seen.has(o.id));
    older = extra.length;
    if (extra.length) { orders = orders.concat(extra); rows = match(parsed, shopify.indexOrders(orders)); }
  }
  return { rows, orders: orders.length, range, older };
}

// --- the match ---------------------------------------------------------------------------------------
const close = (a, b) => Math.abs(a - b) < 0.01;

// Razorpay: order_receipt IS the Shopify payment id. Cashfree: the merchant reference when it is a Shopify
// payment id or order number, else the customer e-mail narrowed by amount; a row with several candidates is
// left "review" rather than guessed.
function findOrder(gateway, row, idx) {
  if (gateway === 'razorpay') {
    const hit = idx.byPayment.get(row.ref);
    return hit ? { order: hit.order, txn: hit.txn, by: 'payment id' } : { reason: row.ref ? 'no Shopify payment has this payment id' : 'the report row has no order_receipt' };
  }
  const byRef = idx.byPayment.get(row.ref);
  if (byRef) return { order: byRef.order, txn: byRef.txn, by: 'payment id' };
  const byNo = idx.byNumber.get(String(row.ref).replace(/^#/, ''));
  if (byNo) return { order: byNo, by: 'order number' };
  const mine = idx.byEmail.get(row.email.toLowerCase()) || [];
  if (!mine.length) return { reason: row.email ? 'no Shopify order for this e-mail' : 'the report row has no customer e-mail' };
  const kind = row.kind === 'refund' ? 'REFUND' : 'SALE';
  const withAmt = mine.filter((o) => o.transactions.some((t) => (t.kind === kind || (kind === 'SALE' && t.kind === 'CAPTURE')) && close(t.amount, row.amount)));
  if (withAmt.length === 1) return { order: withAmt[0], by: 'e-mail + amount' };
  if (withAmt.length > 1) return { review: `${withAmt.length} orders of this customer have that amount (${withAmt.map((o) => o.orderNumber).join(', ')})` };
  if (mine.length === 1 && row.kind === 'payment') return { order: mine[0], by: 'e-mail only', warn: `amount ${row.amount} differs from the order's ${mine[0].total}` };
  return { review: `${mine.length} order(s) for this e-mail, none for ₹${row.amount}` };
}

export function match(parsed, idx) {
  const out = parsed.rows.map((r, i) => {
    const f = findOrder(parsed.gateway, r, idx);
    const row = { id: i + 1, kind: r.kind, date: r.date, ref: r.ref, amount: r.amount, entity: r.entity,
      email: '', orderNumber: '', by: '', status: 'unmatched', problem: f.reason || '' };
    if (f.order) {
      row.email = f.order.email; row.orderNumber = f.order.orderNumber; row.by = f.by; row.status = 'matched';
      const shopAmt = f.txn ? f.txn.amount : null;
      if (f.warn) { row.status = 'review'; row.problem = f.warn; }
      // A refund row carries the original payment's id; it may be part of it, but never more.
      else if (shopAmt != null && (r.kind === 'refund' ? r.amount > shopAmt + 0.01 : !close(shopAmt, r.amount))) { row.status = 'review'; row.problem = `gateway ₹${r.amount} but Shopify payment is ₹${shopAmt}`; }
      else if (!row.email) { row.status = 'review'; row.problem = 'the Shopify order has no e-mail, so there is no customer ledger'; }
    } else if (f.review) { row.status = 'review'; row.problem = f.review; }
    return row;
  });
  return out;
}

export function summarise(parsed, rows) {
  const n = (f) => rows.filter(f).length;
  const sum = (f) => round2(rows.filter(f).reduce((s, r) => s + r.amount, 0));
  return {
    total: rows.length, payments: n((r) => r.kind === 'payment'), refunds: n((r) => r.kind === 'refund'),
    matched: n((r) => r.status === 'matched'), review: n((r) => r.status === 'review'), unmatched: n((r) => r.status === 'unmatched'),
    paymentsAmount: sum((r) => r.kind === 'payment'), refundsAmount: sum((r) => r.kind === 'refund'),
    commission: parsed.commission, entities: parsed.entities,
  };
}

// --- the Journal rows (the old tool's columns) ---------------------------------------------------------
export function journalRows(gateway, rows) {
  const g = GATEWAYS[gateway];
  const list = rows.map((r) => {
    const email = r.email || 'N/A', order = r.orderNumber || 'N/A';
    const pay = r.kind === 'payment';
    return [r.date, pay ? email : g.receivable, pay ? g.receivable : email, order, r.amount, r.ref];
  });
  // Credits (customer paid) first, refunds after: same order as the old tool.
  return list.map((x, i) => [x, i]).sort((a, b) => (a[0][1] === g.receivable) - (b[0][1] === g.receivable) || a[1] - b[1]).map(([x]) => x);
}
export const taxRows = (gateway, parsed) => (parsed.commission > 0
  ? [[parsed.commissionDate, GATEWAYS[gateway].receivable, GATEWAYS[gateway].commission, '', parsed.commission, '']] : []);
export const lookupRows = (rows) => rows.map((r) => [r.ref, r.orderNumber || 'N/A', r.email || 'N/A', r.amount, r.date]);

// --- Excel out -----------------------------------------------------------------------------------------
const FILL = { hdr: '1F3864', credit: 'E2EFDA', debit: 'FCE4D6' };
export async function excel(rows, headers, sheet, { journal = false, receivable = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  const thin = { style: 'thin', color: { argb: 'FFAAAAAA' } };
  const border = { left: thin, right: thin, top: thin, bottom: thin };
  const head = ws.addRow(headers);
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${FILL.hdr}` } };
    c.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.alignment = { horizontal: 'center', vertical: 'center' }; c.border = border;
  });
  headers.forEach((_, i) => { ws.getColumn(i + 1).width = 25; });
  for (const r of rows) {
    const row = ws.addRow(r.map((v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : v)));
    row.eachCell({ includeEmpty: true }, (c, i) => {
      c.border = border;
      if (journal) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${String(r[1]) === receivable ? FILL.debit : FILL.credit}` } };
      if (i === 1 && c.value instanceof Date) c.numFmt = 'DD.MM.YYYY';
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildFiles(gateway, parsed, rows) {
  const g = GATEWAYS[gateway];
  const H = ['Order Date', 'Credit Account', 'Debit Account', 'Debit Reference No', 'gross Amount', 'Narration'];
  return {
    journal: await excel(journalRows(gateway, rows), H, 'Journal', { journal: true, receivable: g.receivable }),
    tax: await excel(taxRows(gateway, parsed), [...H.slice(0, 4), 'Amount', 'Narration'], 'Tax Journal'),
    lookup: await excel(lookupRows(rows), [`${g.label} ID`, 'Order No', 'Email', 'Amount', 'Date'], 'Lookup'),
  };
}
