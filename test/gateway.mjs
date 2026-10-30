// node test/gateway.mjs — the Payment Gateway match and journal rows on made-up reports (no Shopify, no Tally).
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as gw from '../lib/gateway.mjs';
import { indexOrders, normaliseOrder } from '../lib/shopify.mjs';

const book = async (rows) => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('r');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const order = (name, email, total, paymentId, extra = []) => normaliseOrder({
  id: name, name, createdAt: '2026-10-20T10:00:00Z', email, currentTotalPriceSet: { shopMoney: { amount: String(total) } },
  transactions: [{ id: 't' + name, kind: 'SALE', status: 'SUCCESS', gateway: 'razorpay', paymentId, amountSet: { shopMoney: { amount: String(total) } } }, ...extra],
});
const orders = [
  order('#1001', 'a@x.com', 1000, 'pay_A'),
  order('#1002', 'b@x.com', 2500.5, 'pay_B'),
  order('#1003', 'dup@x.com', 700, 'pay_C'),
  order('#1004', 'dup@x.com', 700, 'pay_D'),
  order('#1005', 'solo@x.com', 300, 'pay_E'),
];
const idx = indexOrders(orders);

// --- Razorpay: summary lines above the header, a refund, an on-demand settlement, an unknown receipt, an amount mismatch
const rpHead = ['transaction_entity', 'order_receipt', 'settled_at', 'credit', 'debit', 'amount', 'fee (exclusive tax)', 'tax'];
const rp = await gw.parseFile('razorpay', await book([
  ['Settlement report'], ['Generated', '29/10/2026'], [],
  rpHead,
  ['payment', 'pay_A', '2026-10-27 10:00:00', 1000, 0, 1000, 20, 3.6],
  ['payment', 'pay_B', '28/10/2026', 2500.5, 0, 2500.5, 50, 9],
  ['refund', 'pay_A', new Date('2026-10-28T00:00:00Z'), 0, 400, 400, 0, 0],
  ['settlement.ondemand', '', '2026-10-28', 0, 5000, 5000, 10, 1.8],
  ['payment', 'pay_ZZZ', '2026-10-28', 900, 0, 900, 18, 3.24],
  ['payment', 'pay_E', '2026-10-28', 300, 0, 300, 6, 1.08],
]), 'rp.xlsx');
assert.equal(rp.rows.length, 5, 'on-demand settlement row left out of the journal');
assert.equal(rp.rows[2].kind, 'refund');
assert.equal(rp.rows[1].date, '2026-10-28', 'dd/mm/yyyy text is read as 28 Oct');
assert.equal(rp.commission, 122.72, 'commission = fee + tax over EVERY row, on-demand included');
assert.equal(rp.commissionDate, '2026-10-28');
const m = gw.match(rp, idx);
assert.deepEqual(m.map((r) => r.status), ['matched', 'matched', 'matched', 'unmatched', 'matched']);
assert.equal(m[0].orderNumber, '1001'); assert.equal(m[0].email, 'a@x.com');
assert.match(m[3].problem, /no Shopify payment/);
const mm = gw.match({ ...rp, rows: [{ ...rp.rows[0], amount: 999 }] }, idx);
assert.equal(mm[0].status, 'review'); assert.match(mm[0].problem, /Shopify payment is ₹1000/);
const jr = gw.journalRows('razorpay', m);
assert.deepEqual(jr[0], ['2026-10-27', 'a@x.com', 'Razorpay Payment Receivable', '1001', 1000, 'pay_A']);
assert.equal(jr.at(-1)[1], 'Razorpay Payment Receivable', 'refunds sort last');
assert.deepEqual(jr.at(-1).slice(2, 5), ['a@x.com', '1001', 400]);
assert.deepEqual(jr.find((r) => r[5] === 'pay_ZZZ').slice(1, 4), ['N/A', 'Razorpay Payment Receivable', 'N/A'], 'unmatched rows keep the old N/A form');
assert.deepEqual(gw.taxRows('razorpay', rp), [['2026-10-28', 'Razorpay Payment Receivable', 'Razorpay Commission Paid', '', 122.72, '']]);
assert.deepEqual(gw.shopifyRange(rp), { from: '2026-10-12', to: '2026-10-28' });
const files = await gw.buildFiles('razorpay', rp, m);
const back = new ExcelJS.Workbook(); await back.xlsx.load(files.journal);
const ws = back.worksheets[0];
assert.equal(ws.rowCount, 6); assert.equal(ws.getRow(1).getCell(5).value, 'gross Amount');
assert.equal(ws.getRow(2).getCell(1).numFmt, 'DD.MM.YYYY');
assert.equal(ws.getRow(2).getCell(2).value, 'a@x.com');

// --- Cashfree: reference, e-mail + amount, ambiguous, unknown, refund
const cfHead = ['Event Type', 'Sale Type', 'Customer Email', 'Event Amount', 'Merchant Reference Id', 'Settlement Date'];
const cf = await gw.parseFile('cashfree', await book([
  ['Cashfree settlement'], cfHead,
  ['PAYMENT', 'CREDIT', 'a@x.com', '1,000.00', 'pay_A', '2026-10-28'],
  ['PAYMENT', 'CREDIT', 'b@x.com', 2500.5, 'unknown-ref', '2026-10-28'],
  ['PAYMENT', 'CREDIT', 'dup@x.com', 700, 'r1', '2026-10-28'],
  ['PAYMENT', 'CREDIT', 'solo@x.com', 310, 'r2', '2026-10-28'],
  ['PAYMENT', 'CREDIT', 'nobody@x.com', 50, 'r3', '2026-10-28'],
  ['SETTLEMENT', 'DEBIT', '', 9999, '', '2026-10-28'],
  ['REFUND', 'DEBIT', 'b@x.com', 100, 'rf', '2026-10-28'],
]), 'cf.xlsx');
assert.equal(cf.rows.length, 6, 'only PAYMENT and REFUND rows');
assert.equal(cf.rows[0].amount, 1000);
const c = gw.match(cf, idx);
assert.deepEqual(c.map((r) => [r.status, r.by || '']), [['matched', 'payment id'], ['matched', 'e-mail + amount'], ['review', ''], ['review', 'e-mail only'], ['unmatched', ''], ['review', '']].map(([s, b], i) => (i === 3 ? ['review', 'e-mail only'] : [s, b])));
assert.match(c[2].problem, /2 orders of this customer/); assert.match(c[3].problem, /differs from the order/);
assert.equal(c[5].kind, 'refund'); assert.match(c[5].problem, /none for ₹100/);
assert.equal(gw.taxRows('cashfree', cf).length, 0);

// --- reconcile: the old refund is found by payment id, junk references are not looked up
const OLD = 'rOLDrefundOLDrefundOLDre1';   // r + 24 characters
const oldOrder = order('#900', 'old@x.com', 1500, OLD);
const named = order('#900901', 'named@x.com', 700, 'pay_N');
const looked = [];
const fakeShopify = {
  fetchOrders: async () => orders,
  fetchByPaymentIds: async (ids) => { looked.push(...ids); return ids.includes(OLD) ? [oldOrder] : []; },
  fetchByOrderNumbers: async (nums) => (nums.includes('900901') ? [named] : []),
  indexOrders,
};
const rec = await gw.reconcile('razorpay', { gateway: 'razorpay', rows: [
  { kind: 'payment', date: '2026-10-28', ref: 'pay_A', amount: 1000, entity: 'payment' },
  { kind: 'refund', date: '2026-10-28', ref: OLD, amount: 500, entity: 'refund' },
  { kind: 'payment', date: '2026-10-28', ref: 'Ronin (Demo) i', amount: 9, entity: 'payment' },
  { kind: 'payment', date: '2026-10-28', ref: 'previous order id - #900901', amount: 700, entity: 'payment' },
  { kind: 'payment', date: '2026-10-28', ref: '#900901', amount: 50, entity: 'payment' },
], commission: 0, commissionDate: null, entities: {} }, fakeShopify);
assert.deepEqual(looked, [OLD], 'only a Shopify-shaped reference is searched');
assert.equal(rec.older, 2);
assert.equal(gw.orderNoIn('previous order id - #984286'), '984286'); assert.equal(gw.orderNoIn('Ronin (Demo) i'), null); assert.equal(gw.orderNoIn('123456'), '123456');
assert.deepEqual(rec.rows.map((r) => [r.status, r.orderNumber]), [['matched', '1001'], ['matched', '900'], ['unmatched', ''], ['matched', '900901'], ['review', '900901']]);
assert.equal(rec.rows[3].by, 'order number in reference'); assert.equal(rec.rows[3].email, 'named@x.com');
assert.match(rec.rows[4].problem, /order total is ₹700/);

// --- bad files
await assert.rejects(gw.parseFile('razorpay', await book([['a', 'b'], [1, 2]]), 'x.xlsx'), /does not look like a Razorpay/);
await assert.rejects(gw.parseFile('cashfree', await book([['Event Type', 'Sale Type'], ['PAYMENT', 'CREDIT']]), 'x.xlsx'), /no column: Customer Email/);
console.log('gateway: all checks passed');
