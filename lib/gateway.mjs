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
  // Rows whose reference is not a payment id but names an order ("#986997", "previous order id - #984286"): the
  // order is read by its number and the customer's e-mail comes from it.
  const numbers = [...new Set(rows.filter((r) => r.status === 'unmatched').map((r) => orderNoIn(r.ref)).filter(Boolean))].slice(0, maxLookups);
  if (numbers.length) {
    const seen = new Set(orders.map((o) => o.id));
    const extra = (await shopify.fetchByOrderNumbers(numbers, { onProgress })).filter((o) => !seen.has(o.id));
    older += extra.length;
    orders = orders.concat(extra); rows = match(parsed, shopify.indexOrders(orders));
  }
  return { rows, orders: orders.length, range, older };
}

// The Shopify order number a reference names: "#986997", "previous order id - #984286", or bare digits.
export const orderNoIn = (ref) => { const m = String(ref ?? '').match(/#\s*(\d{5,8})\b/) || String(ref ?? '').trim().match(/^(\d{5,8})$/); return m ? m[1] : null; };

// --- the match ---------------------------------------------------------------------------------------
const close = (a, b) => Math.abs(a - b) < 0.01;

// Razorpay: order_receipt IS the Shopify payment id. Cashfree: the merchant reference when it is a Shopify
// payment id or order number, else the customer e-mail narrowed by amount; a row with several candidates is
// left "review" rather than guessed.
function findOrder(gateway, row, idx) {
  if (gateway === 'razorpay') {
    const hit = idx.byPayment.get(row.ref);
    if (hit) return { order: hit.order, txn: hit.txn, by: 'payment id' };
    const named = idx.byNumber.get(orderNoIn(row.ref));
    if (named) return { order: named, by: 'order number in reference' };
    return { reason: row.ref ? 'no Shopify payment has this payment id' + (orderNoIn(row.ref) ? ` and order ${orderNoIn(row.ref)} was not found` : '') : 'the report row has no order_receipt' };
  }
  const byRef = idx.byPayment.get(row.ref);
  if (byRef) return { order: byRef.order, txn: byRef.txn, by: 'payment id' };
  const byNo = idx.byNumber.get(orderNoIn(row.ref));
  if (byNo) return { order: byNo, by: 'order number in reference' };
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
      // Found by an order number written in the reference, not by a payment id: no payment to compare, so the order's total.
      else if (!f.txn && f.by === 'order number in reference' && (r.kind === 'refund' ? r.amount > f.order.total + 0.01 : !close(f.order.total, r.amount))) {
        row.status = 'review'; row.problem = `found by order number ${f.order.orderNumber}; gateway ₹${r.amount} but the order total is ₹${f.order.total}`;
      }
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

// --- is it already in Tally? -------------------------------------------------------------------------
// A booked gateway journal has the gateway reference as its narration, the Receivable ledger on one line (payment: Dr,
// refund: Cr) and the amount. The journals from the first settlement date to a week after the last are read (ten days of
// ~12k journals take a few seconds) and each report row is paired with one journal of the same reference, kind and amount.
// More journals than rows = booked more than once (it happens in the books); more rows than journals = the rest are missing.
const cents = (n) => Math.round(Math.abs(n) * 100);
const ymd = (iso) => iso.replace(/-/g, '');
const isoYmd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export async function tallyCheck(gateway, parsed, rows, tally, { onProgress, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) } = {}) {
  const g = GATEWAYS[gateway];
  const dates = rows.map((r) => r.date).concat(parsed.commissionDate && parsed.commission > 0 ? [parsed.commissionDate] : []).filter(Boolean).sort();
  if (!dates.length) return { rows, info: { error: 'No settlement dates, so there is nothing to look up in Tally.' } };
  const from = dates[0], last = dates[dates.length - 1];
  let to = shiftIso(last, 7); if (to > today) to = today; if (to < last) to = last;

  const booked = new Map(), commissions = [];
  let journals = 0;
  for (let f = from; f <= to;) {
    const t = shiftIso(f, 4) < to ? shiftIso(f, 4) : to;
    onProgress?.(`Tally: reading journals ${f} to ${t}…`);
    for (const j of await tally.journalsInRange(ymd(f), ymd(t), { lines: true })) {
      if (j.cancelled) continue;
      journals++;
      const brief = { no: j.no, date: isoYmd(j.date), optional: j.optional };
      for (const l of j.lines || []) {
        if (lc(l.ledger) === lc(g.receivable) && j.narration.trim()) {
          const key = `${j.narration.trim()}|${l.amount > 0 ? 'refund' : 'payment'}|${cents(l.amount)}`;
          (booked.get(key) || booked.set(key, []).get(key)).push(brief);
        } else if (lc(l.ledger) === lc(g.commission) && l.amount < 0) commissions.push({ ...brief, amount: -l.amount });
      }
    }
    f = shiftIso(t, 1);
  }

  const used = new Map();
  const out = rows.map((r) => {
    const key = `${r.ref}|${r.kind}|${cents(r.amount)}`;
    const list = r.ref ? booked.get(key) || [] : [];
    const n = used.get(key) || 0;
    used.set(key, n + 1);
    const hit = list[n];
    if (!hit) return { ...r, tally: { state: 'missing' } };
    return { ...r, tally: { state: 'booked', no: hit.no, date: hit.date, optional: hit.optional, times: list.length > 1 && n === 0 ? list.length : 0 } };
  });
  // More journals than report rows of the same key: the surplus is shown on the first row of the key.
  const rowsOf = new Map();
  for (const r of out) { const k = `${r.ref}|${r.kind}|${cents(r.amount)}`; rowsOf.set(k, (rowsOf.get(k) || 0) + 1); }
  for (const r of out) {
    const k = `${r.ref}|${r.kind}|${cents(r.amount)}`;
    if (r.tally.state === 'booked' && r.tally.times) { if (booked.get(k).length <= rowsOf.get(k)) r.tally.times = 0; }
  }

  let commission = null;
  if (parsed.commission > 0) {
    const c = commissions.find((x) => close(x.amount, parsed.commission));
    commission = c ? { state: 'booked', no: c.no, date: c.date } : { state: 'missing' };
  }
  const n = (s) => out.filter((r) => r.tally.state === s).length;
  return { rows: out, info: { checkedAt: new Date().toISOString(), from, to, journals, booked: n('booked'), missing: n('missing'),
    twice: out.filter((r) => r.tally.times).length, commission, error: '' } };
}

// --- posting to Tally -----------------------------------------------------------------------------------
// One Journal per payment / refund, as the accounts book them (read from Tally 2026-10-30): payment Cr customer e-mail
// ledger (bill Agst Ref = order number) / Dr Receivable; refund the other way round; dated the settlement date;
// narration = the gateway reference. The Razorpay commission is Cr Receivable / Dr Commission Paid, no narration.
// Same voucher shape and Cr + / Dr − convention as the COD journals (lib/cod.mjs).
const fixed = (x) => round2(x).toFixed(2);
export function buildJournal({ number, date, ledger, billWise, bill, narration, amount, kind, receivable, optional }) {
  const amt = fixed(amount);
  const head = { metadata: { type: 'Voucher', vchtype: 'Journal', action: 'Create', objview: 'Accounting Voucher View' },
    date, effectivedate: date, vouchertypename: 'Journal', vouchernumber: String(number), persistedview: 'Accounting Voucher View',
    ...(optional ? { isoptional: true } : {}), narration };
  if (kind === 'commission') return { ...head, ledgerentries: [
    { ledgername: receivable, isdeemedpositive: false, ispartyledger: false, amount: amt },
    { ledgername: ledger, isdeemedpositive: true, ispartyledger: false, amount: '-' + amt }] };
  const refund = kind === 'refund';   // payment: customer Cr (+), receivable Dr (−); refund the other way round
  const cAmt = refund ? '-' + amt : amt;
  const cust = { ledgername: ledger, isdeemedpositive: refund, ispartyledger: true, amount: cAmt,
    ...(billWise === false || !bill ? {} : { billallocations: [{ name: bill, billtype: 'Agst Ref', amount: cAmt }] }) };
  const recv = { ledgername: receivable, isdeemedpositive: !refund, ispartyledger: false, amount: refund ? amt : '-' + amt };
  return { ...head, ledgerentries: refund ? [recv, cust] : [cust, recv] };
}

const replyErrors = (r) => {
  const list = [...(r?.error_list || []), ...(r?.data?.error_list || [])];
  const txt = list.map((e) => (typeof e === 'string' ? e : e?.error || e?.message || e?.line_error || '')).filter(Boolean);
  const res = r?.data?.import_result || r?.import_result || list.find((e) => e?.data?.import_result)?.data?.import_result;
  if (res && (Number(res.errors) || Number(res.exceptions))) txt.push('Tally reported ' + res.errors + ' error(s)' + (Number(res.exceptions) ? ', ' + res.exceptions + ' exception(s)' : ''));
  return txt.join('; ');
};

const BATCH = 25;
const looseKey = (s) => String(s).toLowerCase().replace(/[.\-\s]/g, '');
// Post every matched row that Tally does not have yet (a fresh Tally check first, so nothing is posted twice), and the
// commission journal when it is missing. Batches never mix dates; each is read back from Tally and compared line by line,
// and a batch with anything missing stops the run (nothing after it is sent). deps is lib/tally.mjs + the number helpers
// of lib/cod.mjs, passed in so this stays testable without Tally.
export async function postJournals(gateway, report, deps, { optional = false, company = '', onProgress, log } = {}) {
  const g = GATEWAYS[gateway];
  const say = (message, done, total) => onProgress?.({ message, done, total });
  say('Checking Tally for journals already booked…');
  const fresh = await tallyCheck(gateway, { commission: report.commission, commissionDate: report.commissionDate }, report.rows, deps, { onProgress: (m) => say(m) });
  if (fresh.info.error) throw new Error(fresh.info.error);
  const result = { posted: 0, failed: 0, alreadyThere: 0, notPostable: 0, blocked: [], errors: [], firstNo: null, lastNo: null, commission: null, rows: fresh.rows, info: fresh.info };
  const todo = [];
  for (const r of fresh.rows) {
    if (r.tally.state === 'booked') result.alreadyThere++;
    else if (r.status !== 'matched' || !(r.amount > 0) || !r.date || !r.ref) result.notPostable++;
    else todo.push(r);
  }
  const wantCommission = fresh.info.commission?.state === 'missing' && report.commission > 0 && report.commissionDate;
  if (!todo.length && !wantCommission) return result;

  say('Looking up ' + todo.length + ' customer ledgers…');
  const have = await deps.existingLedgers([g.receivable, g.commission]);
  for (const l of [g.receivable, ...(wantCommission ? [g.commission] : [])]) if (!have.has(l)) throw new Error('Ledger "' + l + '" is not in the open Tally company.');
  const all = await deps.allLedgerNamesByLower();
  const loose = new Map();
  for (const real of all.values()) { const k = looseKey(real); loose.set(k, loose.has(k) ? null : real); }   // null: two ledgers collide
  const ledgerFor = (email) => all.get(email.toLowerCase()) || loose.get(looseKey(email)) || null;
  const ready = [];
  for (const r of todo) {
    const ledger = r.email ? ledgerFor(r.email) : null;
    if (!ledger) { result.blocked.push({ ref: r.ref, reason: r.email ? 'customer ledger "' + r.email + '" is not in Tally' : 'no customer e-mail' }); continue; }
    ready.push({ row: r, ledger });
  }
  const billWise = ready.length ? await deps.ledgersBillWise([...new Set(ready.map((x) => x.ledger))]) : new Map();
  const postable = ready.filter((x) => {
    x.billWise = billWise.get(x.ledger);
    if (x.billWise === undefined) { result.blocked.push({ ref: x.row.ref, reason: 'ledger "' + x.ledger + '" could not be read from Tally' }); return false; }
    return true;
  });

  // Credits first, refunds after, in date order: as the accounts book them.
  const items = postable.map((x) => ({ date: ymd(x.row.date), kind: x.row.kind, ref: x.row.ref, amount: x.row.amount, ledger: x.ledger, billWise: x.billWise,
    bill: x.row.orderNumber, row: x.row })).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'refund') - (b.kind === 'refund'));
  if (wantCommission) items.push({ date: ymd(report.commissionDate), kind: 'commission', ref: '', amount: report.commission, ledger: g.commission, commission: true });
  const batches = [];
  for (const it of items) { const last = batches[batches.length - 1]; if (last && last.length < BATCH && last[0].date === it.date) last.push(it); else batches.push([it]); }

  let next = (await deps.yearMaxJournal(company, (m) => say(m))) + 1;
  let done = 0;
  for (const batch of batches) {
    const date = batch[0].date;
    const numbered = batch.map((it) => ({ it, number: next++ }));
    say('Posting ' + (done + 1) + '–' + (done + batch.length) + ' of ' + items.length + ' (dated ' + isoYmd(date) + ')…', done, items.length);
    done += batch.length;
    const vouchers = numbered.map(({ it, number }) => buildJournal({ number, date, ledger: it.ledger, billWise: it.billWise, bill: it.bill, narration: it.ref, amount: it.amount, kind: it.kind, receivable: g.receivable, optional }));
    let reply;
    try { reply = await deps.importVouchers(vouchers); } catch (err) { reply = { error_list: [err.message] }; }
    log?.('Gateway batch ' + numbered[0].number + '-' + numbered[numbered.length - 1].number, vouchers, reply);
    const back = new Map();
    for (const j of await deps.journalsInRange(date, date, { lines: true })) if (!j.cancelled) back.set(j.no, j);
    let missing = 0;
    for (const { it, number } of numbered) {
      const found = back.get(String(number));
      if (!found) { missing++; result.failed++; continue; }
      const checks = [];
      const rl = found.lines.find((l) => lc(l.ledger) === lc(g.receivable)), other = found.lines.find((l) => l !== rl);
      const want = it.kind === 'payment' ? -1 : 1;   // receivable line: payment Dr (−), refund and commission Cr (+)
      if (!rl || Math.abs(rl.amount - want * round2(it.amount)) > 0.005) checks.push('receivable line is ' + (rl ? rl.amount : 'missing'));
      if (lc(other?.ledger) !== lc(it.ledger)) checks.push('other ledger is ' + (other?.ledger || 'missing'));
      if (it.kind !== 'commission') {
        if (found.narration.trim() !== it.ref) checks.push('narration is "' + found.narration + '"');
        const b = other?.bills?.[0];
        if (it.billWise !== false && it.bill && (b?.name !== it.bill || b?.type !== 'Agst Ref')) checks.push('bill is ' + (b?.name || 'missing') + ' ' + (b?.type || ''));
      }
      if (found.optional !== Boolean(optional)) checks.push(found.optional ? 'Optional in Tally' : 'regular in Tally, sent as Optional');
      const booked = { state: 'booked', no: found.no, date: isoYmd(found.date), optional: found.optional, times: 0 };
      if (it.commission) result.commission = { state: 'booked', no: found.no, date: booked.date };
      else { it.row.tally = booked; result.posted++; }
      result.firstNo ??= found.no; result.lastNo = found.no;
      if (checks.length) result.errors.push((it.ref || 'commission') + ' (' + found.no + '): ' + checks.join('; '));
    }
    deps.journalNumbersTaken(company, next - 1);
    if (missing) {
      deps.forgetJournalMax();   // a number may have been taken: scan the year again next time
      const why = replyErrors(reply);
      result.errors.unshift(missing + ' of ' + numbered.length + ' in the batch from ' + numbered[0].number + ' were not posted' + (why ? ' — ' + why : '') + '. Stopped; nothing after them was sent.');
      break;
    }
  }
  return result;
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

// skipBooked: leave out the rows the Tally check found already booked (and the commission journal, if booked).
export async function buildFiles(gateway, parsed, rows, { skipBooked = false, commissionBooked = false } = {}) {
  const g = GATEWAYS[gateway];
  const H = ['Order Date', 'Credit Account', 'Debit Account', 'Debit Reference No', 'gross Amount', 'Narration'];
  const todo = skipBooked ? rows.filter((r) => r.tally?.state !== 'booked') : rows;
  return {
    journal: await excel(journalRows(gateway, todo), H, 'Journal', { journal: true, receivable: g.receivable }),
    tax: await excel(skipBooked && commissionBooked ? [] : taxRows(gateway, parsed), [...H.slice(0, 4), 'Amount', 'Narration'], 'Tax Journal'),
    lookup: await excel(lookupRows(rows), [`${g.label} ID`, 'Order No', 'Email', 'Amount', 'Date'], 'Lookup'),
  };
}
