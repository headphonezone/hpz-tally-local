// Posting rows marked "review": only when allowed, to the customer of the order or of the report, never to a guess.
import assert from 'node:assert/strict';
import * as gw from '../lib/gateway.mjs';

const store = [], sent = [];
const deps = {
  journalsInRange: async (f, t) => store.filter((j) => j.date >= f && j.date <= t),
  existingLedgers: async (n) => new Set(n),
  allLedgerNamesByLower: async () => new Map(['a@x.com', 'b@x.com'].map((x) => [x, x])),
  ledgersBillWise: async (n) => new Map(n.map((x) => [x, true])),
  importVouchers: async (vs) => { for (const v of vs) { sent.push(v); store.push({ no: v.vouchernumber, date: v.date, narration: v.narration, cancelled: false, optional: false,
    lines: v.ledgerentries.map((l) => ({ ledger: l.ledgername, amount: Number(l.amount), bills: (l.billallocations || []).map((b) => ({ name: b.name, type: b.billtype, amount: Number(b.amount) })) })) }); } return { status: '1' }; },
  yearMaxJournal: async () => 7000, journalNumbersTaken() {}, forgetJournalMax() {},
};
const row = (id, ref, status, extra = {}) => ({ id, kind: 'payment', date: '2026-11-01', ref, amount: 10 * id, email: '', orderNumber: '', status, reportEmail: '', ...extra });
const mk = () => ({ commission: 0, rows: [
  row(1, 'm1', 'matched', { email: 'a@x.com', orderNumber: '11' }),
  row(2, 'v1', 'review', { email: 'a@x.com', orderNumber: '12', problem: 'amount differs' }),   // found its order, amount differs
  row(3, 'v2', 'review', { reportEmail: 'b@x.com', problem: '2 orders have that amount' }),     // no single order; the report names a customer
  row(4, 'v3', 'review', { reportEmail: 'nobody@x.com' }),                                        // customer not in Tally
  row(5, 'v4', 'review'),                                                                         // nothing at all
  row(6, 'u1', 'unmatched', { reportEmail: 'a@x.com' }),                                          // not found: never posted
] });
const all = new Set([1, 2, 3, 4, 5, 6]);

// Without the option: review rows are left out, as before.
let out = await gw.postJournals('cashfree', mk(), deps, { company: 'Co', commission: false, only: all });
assert.equal(out.posted, 1);
assert.equal(out.notPostable, 5);
assert.deepEqual(sent.map((v) => v.narration), ['m1']);

// With it: the two postable review rows go in; the other two are blocked with a reason; "not found" stays out.
sent.length = 0; store.length = 0;
out = await gw.postJournals('cashfree', mk(), deps, { company: 'Co', commission: false, only: all, review: true });
assert.equal(out.posted, 3, JSON.stringify(out.blocked));
assert.deepEqual(sent.map((v) => v.narration).sort(), ['m1', 'v1', 'v2']);
assert.equal(out.notPostable, 1, 'the not-found row');
assert.deepEqual(out.blocked.map((b) => b.ref).sort(), ['v3', 'v4']);
assert.match(out.blocked.find((b) => b.ref === 'v3').reason, /nobody@x\.com.*not in Tally/);
assert.equal(out.blocked.find((b) => b.ref === 'v4').reason, 'no customer e-mail');
const party = (ref) => sent.find((v) => v.narration === ref).ledgerentries.find((l) => l.ispartyledger);
assert.equal(party('v1').ledgername, 'a@x.com'); assert.equal(party('v1').billallocations[0].name, '12');
assert.equal(party('v2').ledgername, 'b@x.com'); assert.equal(party('v2').billallocations, undefined, 'no order: no bill (On Account)');

// Not ticked: not posted even with the option on.
sent.length = 0; store.length = 0;
out = await gw.postJournals('cashfree', mk(), deps, { company: 'Co', commission: false, only: new Set([1]), review: true });
assert.deepEqual(sent.map((v) => v.narration), ['m1']);

// match() keeps the report's e-mail on a review row without an order
const parsed = { gateway: 'cashfree', rows: [{ kind: 'payment', date: '2026-11-01', ref: 'zz', amount: 50, email: 'b@x.com' }] };
const o1 = { id: 1, orderNumber: '1', email: 'b@x.com', total: 50, transactions: [{ kind: 'SALE', amount: 50 }] };
const o2 = { id: 2, orderNumber: '2', email: 'b@x.com', total: 50, transactions: [{ kind: 'SALE', amount: 50 }] };
const idx = { byPayment: new Map(), byNumber: new Map(), byEmail: new Map([['b@x.com', [o1, o2]]]) };
const m = gw.match(parsed, idx)[0];
assert.equal(m.status, 'review'); assert.equal(m.email, ''); assert.equal(m.reportEmail, 'b@x.com');

console.log('gateway-review-post: ok');
