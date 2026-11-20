// New Ref / Agst Ref choice between a payment journal and its invoice (lib/billref.mjs), and its use by both posting flows.
import assert from 'node:assert/strict';
import { keyOf, indexInvoices, indexNewRefJournals, paymentBillType, invoiceBillType } from '../lib/billref.mjs';
import * as gw from '../lib/gateway.mjs';
import { buildSalesVoucher } from '../lib/ucsales.mjs';

// --- the pure rules
const inv = indexInvoices([
  { party: 'A@x.com', ref: '1', bills: [{ name: '1', type: 'New Ref' }] },       // invoice opened the bill
  { party: 'b@x.com', ref: '2', bills: [{ name: '2', type: 'Agst Ref' }] },      // invoice settles a bill the payment opened
  { party: 'c@x.com', ref: '3', bills: [{ name: '', type: 'On Account' }] },     // invoice without a bill
]);
assert.equal(inv.get(keyOf('a@x.com', '1')).type, 'New Ref');
assert.equal(inv.get(keyOf('b@x.com', '2')).type, 'Agst Ref');
assert.equal(inv.get(keyOf('c@x.com', '3')).type, 'On Account');
assert.equal(inv.get(keyOf('d@x.com', '4')), undefined);
assert.equal(paymentBillType(inv.get(keyOf('a@x.com', '1'))), 'Agst Ref', 'invoice holds the bill: the payment settles it');
assert.equal(paymentBillType(inv.get(keyOf('b@x.com', '2'))), 'New Ref', 'invoice settles it: the payment is the bill');
assert.equal(paymentBillType(inv.get(keyOf('c@x.com', '3'))), 'New Ref');
assert.equal(paymentBillType(undefined), 'New Ref', 'no invoice yet');
const paid = indexNewRefJournals([{ party: 'E@x.com', date: '20261101', bills: [{ name: '9', type: 'New Ref' }] }, { party: 'f@x.com', date: '20261101', bills: [{ name: '8', type: 'Agst Ref' }] }]);
assert.equal(invoiceBillType(paid.get(keyOf('e@x.com', '9')), '20261105'), 'Agst Ref', 'a payment holds the bill: the invoice settles it');
assert.equal(invoiceBillType(paid.get(keyOf('e@x.com', '9')), '20261031'), 'New Ref', 'payment dated after the invoice: the invoice is the bill');
assert.equal(invoiceBillType(paid.get(keyOf('f@x.com', '8')), '20261105'), 'New Ref', 'only an open New Ref counts');

// --- the sales invoice carries the chosen type
const note = { customer_email: 'e@x.com', sale_order_number: '9', party_amount: 100, gst_registration_type: 'Regular', tax: [], charges: [], lines: [] };
const bt = (t) => buildSalesVoucher({ voucherNumber: 'V1', date: '20261101', note, billType: t }).ledgerentries[0].billallocations[0].billtype;
assert.equal(bt(), 'New Ref', 'default as before');
assert.equal(bt('Agst Ref'), 'Agst Ref');

// --- the gateway posting
const store = [], sent = [];
const deps = (invoiceBills) => ({
  journalsInRange: async (f, t) => store.filter((j) => j.date >= f && j.date <= t),
  existingLedgers: async (n) => new Set(n), allLedgerNamesByLower: async () => new Map(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'].map((x) => [x, x])),
  ledgersBillWise: async (n) => new Map(n.map((x) => [x, true])),
  importVouchers: async (vs) => { for (const v of vs) { sent.push(v); store.push({ no: v.vouchernumber, date: v.date, narration: v.narration, cancelled: false, optional: false,
    lines: v.ledgerentries.map((l) => ({ ledger: l.ledgername, amount: Number(l.amount), bills: (l.billallocations || []).map((b) => ({ name: b.name, type: b.billtype, amount: Number(b.amount) })) })) }); } return { status: '1' }; },
  yearMaxJournal: async () => 7000, journalNumbersTaken() {}, forgetJournalMax() {}, invoiceBills,
});
const row = (ref, email, order, amount, kind = 'payment') => ({ kind, date: '2026-11-01', ref, email, orderNumber: order, amount, status: 'matched' });
const report = { commission: 0, rows: [row('p1', 'a@x.com', '1', 10), row('p2', 'b@x.com', '2', 20), row('p3', 'c@x.com', '3', 30), row('p4', 'd@x.com', '4', 40), row('r1', 'a@x.com', '1', 5, 'refund')] };
const out = await gw.postJournals('razorpay', report, deps(async () => inv), { company: 'Co', commission: false });
const typeOf = (ref) => sent.find((v) => v.narration === ref).ledgerentries.find((l) => l.ispartyledger).billallocations[0].billtype;
assert.deepEqual([typeOf('p1'), typeOf('p2'), typeOf('p3'), typeOf('p4'), typeOf('r1')], ['Agst Ref', 'New Ref', 'New Ref', 'New Ref', 'Agst Ref']);
assert.equal(out.posted, 5);
assert.deepEqual(out.errors, [], 'no warnings: what was read back is what was chosen');
assert.deepEqual(out.billCheck, { checked: true, settles: 1, waitingForInvoice: 1, invoiceSettlesIt: 1, invoiceOnAccount: 1 });

// the invoice look-up failing must not stop posting: as before, Agst Ref, Tally decides
sent.length = 0; store.length = 0;
const out2 = await gw.postJournals('razorpay', { commission: 0, rows: [row('q1', 'a@x.com', '1', 10)] }, deps(async () => { throw new Error('busy'); }), { company: 'Co', commission: false });
assert.equal(out2.posted, 1); assert.equal(typeOf('q1'), 'Agst Ref'); assert.ok(out2.billCheck.error.includes('busy'));
console.log('billref: all checks passed');

// --- a customer who was never invoiced: the ledger is made from the Shopify order, then the payment posts
{
  const known = new Set(['a@x.com', 'Razorpay Payment Receivable']); const made = [];
  const dd = deps(async () => new Map());
  dd.allLedgerNamesByLower = async () => new Map([...known].map((x) => [x.toLowerCase(), x]));
  dd.existingLedgers = async (n) => new Set(n.filter((x) => known.has(x)));
  dd.createLedgers = async (specs) => { for (const s of specs) { made.push(s); known.add(s.email); } return { status: '1' }; };
  sent.length = 0; store.length = 0;
  const cust = { name: 'Ini Sheldon', mobile: '9999999999', state: 'Tamil Nadu', addressLines: ['1 Main St', 'Chennai 600001'] };
  const rep = { commission: 0, rows: [{ ...row('n1', 'New@x.com', '50', 70), customer: cust, date: '2026-10-07' }, { ...row('n2', 'New@x.com', '50', 70, 'refund'), customer: cust, date: '2026-10-09' }, row('n3', 'a@x.com', '51', 5)] };
  const o = await gw.postJournals('razorpay', rep, dd, { company: 'Co', commission: false });
  assert.equal(made.length, 1, 'one ledger for the customer, whatever the number of rows');
  assert.equal(made[0].email, 'New@x.com'); assert.equal(made[0].name, 'Ini Sheldon'); assert.equal(made[0].state, 'Tamil Nadu');
  assert.equal(made[0].dateYmd, '20261007', 'valid from the customer\'s first row');
  assert.equal(o.ledgersCreated, 1); assert.equal(o.posted, 3); assert.equal(o.blocked.length, 0);
  // a ledger that did not come out stays blocked
  const dd2 = { ...dd, createLedgers: async () => ({ status: '0' }), allLedgerNamesByLower: async () => new Map([['a@x.com', 'a@x.com']]), existingLedgers: async (n) => new Set(n.filter((x) => x === 'a@x.com' || x === 'Razorpay Payment Receivable')) };
  const o2 = await gw.postJournals('razorpay', { commission: 0, rows: [{ ...row('m1', 'gone@x.com', '60', 9), customer: cust }] }, dd2, { company: 'Co', commission: false });
  assert.equal(o2.posted, 0); assert.equal(o2.blocked.length, 1);
}
console.log('billref (ledgers): all checks passed');

// --- dates: an Agst Ref only settles a bill that already exists on that date
{
  const dated = indexInvoices([{ party: 'a@x.com', ref: '1', date: '20261105', bills: [{ name: '1', type: 'New Ref' }] }]);
  const i = dated.get(keyOf('a@x.com', '1'));
  assert.equal(paymentBillType(i, '20261106'), 'Agst Ref', 'payment after the invoice settles it');
  assert.equal(paymentBillType(i, '20261105'), 'Agst Ref', 'same day');
  assert.equal(paymentBillType(i, '20261104'), 'New Ref', 'payment before the invoice: it is the bill, the invoice settles it');
  sent.length = 0; store.length = 0;
  const o = await gw.postJournals('razorpay', { commission: 0, rows: [{ ...row('d1', 'a@x.com', '1', 10), date: '2026-11-04' }] }, deps(async () => dated), { company: 'Co', commission: false });
  assert.equal(typeOf('d1'), 'New Ref'); assert.deepEqual(o.errors, []);
  // a refund booked BEFORE its payment (no invoice): the refund opens the bill, the payment settles it
  sent.length = 0; store.length = 0;
  const o2 = await gw.postJournals('razorpay', { commission: 0, rows: [{ ...row('e1', 'b@x.com', '7', 10), date: '2026-11-04' }, { ...row('e2', 'b@x.com', '7', 10, 'refund'), date: '2026-11-02' }] }, deps(async () => new Map()), { company: 'Co', commission: false });
  assert.deepEqual([typeOf('e1'), typeOf('e2')], ['Agst Ref', 'New Ref']); assert.deepEqual(o2.errors, []); assert.equal(o2.posted, 2);
}
console.log('billref (dates): all checks passed');
