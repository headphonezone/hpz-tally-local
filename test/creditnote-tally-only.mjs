// Offline checks: a Fetch lists the Goods Return credit notes Tally holds for the dates as "already in Tally" for every
// order RMS no longer has pending (31-Oct-2026 fetched as 0 orders although 23 were credited that day).
//   node test/creditnote-tally-only.mjs
import assert from 'node:assert/strict';
import { tallyOnlyRows, VOUCHER_TYPE } from '../lib/creditnote.mjs';

const v = (voucherNumber, date, extra = {}) => ({ voucherNumber, date, party: `${voucherNumber}@x.com`, mailingName: 'A', cancelled: false, amount: 100,
  items: [{ item: 'KZ - EDX Pro', qty: 1 }], ...extra });

// One row per order, from Tally alone, never ticked.
const rows = tallyOnlyRows([
  v('1180623', '20261031', { amount: 1598, items: [{ item: 'KZ - EDX Pro', qty: 1 }, { item: 'JCALLY - JM12', qty: 1 }] }),
  v('1145429', '20261031'),
], new Set());
assert.equal(rows.length, 2);
const r = rows.find((x) => x.order_no === '1180623');
assert.equal(r.status, 'intally');
assert.equal(r.from_tally, true);
assert.equal(r.first_received_date, '2026-10-31');
assert.equal(r.tally_amount, 1598);
assert.equal(r.customer_email, '1180623@x.com');
assert.deepEqual(r.rms_items.map((i) => i.item), ['KZ - EDX Pro', 'JCALLY - JM12']);
assert.deepEqual(r.existing, [{ voucherNumber: '1180623', date: '20261031', type: VOUCHER_TYPE, items: r.rms_items }]);
assert.deepEqual(r.problems, []);

// An order still pending in RMS keeps its own row (which already shows its credit notes): not listed twice.
assert.deepEqual(tallyOnlyRows([v('1180623', '20261031'), v('1180623-1', '20261031')], new Set(['1180623'])), []);

// order and order-N are one order: both notes on one row, oldest first, amounts added.
const two = tallyOnlyRows([v('1190108-1', '20261102', { amount: 50.25 }), v('1190108', '20261031', { amount: 100.1 })], new Set());
assert.equal(two.length, 1);
assert.equal(two[0].order_no, '1190108');
assert.deepEqual(two[0].existing.map((e) => e.voucherNumber), ['1190108', '1190108-1']);
assert.equal(two[0].first_received_date, '2026-10-31');
assert.equal(two[0].tally_amount, 150.35);

// A cancelled credit note credits nothing; a number that is not order / order-N is listed under itself.
assert.deepEqual(tallyOnlyRows([v('1202788', '20261031', { cancelled: true })], new Set()), []);
assert.equal(tallyOnlyRows([v('CN-12', '20261031')], new Set())[0].order_no, 'CN-12');

// An amount Tally did not give is shown as unknown, not as 0.
assert.equal(tallyOnlyRows([v('1', '20261031', { amount: null }), v('1-1', '20261031')], new Set())[0].tally_amount, null);

console.log('creditnote-tally-only: all checks passed');
