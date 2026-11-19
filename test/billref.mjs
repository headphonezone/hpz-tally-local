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
assert.equal(inv.get(keyOf('a@x.com', '1')), 'New Ref');
assert.equal(inv.get(keyOf('b@x.com', '2')), 'Agst Ref');
assert.equal(inv.get(keyOf('c@x.com', '3')), 'On Account');
assert.equal(inv.get(keyOf('d@x.com', '4')), undefined);
assert.equal(paymentBillType(inv.get(keyOf('a@x.com', '1'))), 'Agst Ref', 'invoice holds the bill: the payment settles it');
assert.equal(paymentBillType(inv.get(keyOf('b@x.com', '2'))), 'New Ref', 'invoice settles it: the payment is the bill');
assert.equal(paymentBillType(inv.get(keyOf('c@x.com', '3'))), 'New Ref');
assert.equal(paymentBillType(undefined), 'New Ref', 'no invoice yet');
const paid = indexNewRefJournals([{ party: 'E@x.com', bills: [{ name: '9', type: 'New Ref' }] }, { party: 'f@x.com', bills: [{ name: '8', type: 'Agst Ref' }] }]);
assert.equal(invoiceBillType(paid.has(keyOf('e@x.com', '9'))), 'Agst Ref', 'a payment holds the bill: the invoice settles it');
assert.equal(invoiceBillType(paid.has(keyOf('f@x.com', '8'))), 'New Ref', 'only an open New Ref counts');

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
