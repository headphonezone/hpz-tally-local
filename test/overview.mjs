// Offline checks for the Generate Report helpers.   node test/overview.mjs
import assert from 'node:assert/strict';
import { fyBounds, monthLabel, monthsBetween, quarterChunks, monthOfOrder, missingSalesByMonth, latestJournalDates, countByMonth, countByDay } from '../lib/overview.mjs';

assert.deepEqual(fyBounds('2026-11-05'), { from: '2026-04-01', to: '2026-11-05' });
assert.deepEqual(fyBounds('2027-02-10'), { from: '2026-04-01', to: '2027-02-10' });
assert.deepEqual(fyBounds('2026-04-01'), { from: '2026-04-01', to: '2026-04-01' });
assert.equal(monthLabel('2026-04'), 'Apr 2026');
assert.deepEqual(monthsBetween('2026-04-01', '2026-06-30'), ['2026-04', '2026-05', '2026-06']);
assert.deepEqual(monthsBetween('2026-11-01', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);

assert.deepEqual(quarterChunks('2026-04-01', '2026-11-05'), [['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-11-05']]);
assert.deepEqual(quarterChunks('2026-04-01', '2027-03-31').length, 4);
assert.deepEqual(quarterChunks('2026-05-10', '2026-05-12'), [['2026-05-10', '2026-05-12']]);
assert.deepEqual(quarterChunks('2026-12-30', '2027-01-02'), [['2026-12-30', '2026-12-31'], ['2027-01-01', '2027-01-02']]);

assert.equal(monthOfOrder('03-11-2026'), '2026-11');
assert.equal(monthOfOrder('x'), null);

const orders = [
  { invoice: 'A1', date: '01-04-2026' }, { invoice: 'A2', date: '30-04-2026' }, { invoice: 'B1', date: '02-05-2026' },
  { invoice: 'M1', date: '03-05-2026', mumbai: true }, { invoice: 'Z', date: 'bad' },
];
const r = missingSalesByMonth(orders, { isTaken: (i) => i === 'A1', keep: (o) => !o.mumbai, from: '2026-04-01', to: '2026-06-30' });
assert.deepEqual(r.months, [{ month: '2026-04', orders: 2, missing: 1 }, { month: '2026-05', orders: 1, missing: 1 }, { month: '2026-06', orders: 0, missing: 0 }]);
assert.equal(r.undated, 1);

const j = (no, date, ledgers, extra = {}) => ({ no, date, cancelled: false, optional: false, lines: ledgers.map((ledger) => ({ ledger })), ...extra });
const last = latestJournalDates([
  j('1', '20261101', ['COD Sales', 'a@b.com']), j('2', '20261103', ['COD Sales', 'c@d.com']), j('3', '20261104', ['COD Sales'], { cancelled: true }),
  j('4', '20261102', ['cashfree receivable', 'x']), j('5', '20261105', ['Razorpay Payment Receivable'], { optional: true }), j('6', '20261105', ['Other']),
], { cod: ['COD Sales', 'DTDC EXPRESS Receivable'], cashfree: ['Cashfree Receivable'], razorpay: ['Razorpay Payment Receivable'], delhivery: ['Delhivery COD Receivable'] });
assert.deepEqual(last.cod, { date: '20261103', number: '2', optional: false, count: 2 });
assert.equal(last.cashfree.date, '20261102');
assert.equal(last.razorpay.optional, true);
assert.equal(last.delhivery, null);

const c = countByMonth([{ d: '2026-04-03' }, { d: '2026-04-30' }, { d: '2026-06-01' }, { d: '2025-01-01' }], (x) => x.d, '2026-04-01', '2026-06-30');
assert.deepEqual(c, [{ month: '2026-04', count: 2 }, { month: '2026-05', count: 0 }, { month: '2026-06', count: 1 }]);
assert.deepEqual(countByDay([{ d: '2026-11-03' }, { d: '2026-11-03' }, { d: '2026-11-05' }, { d: '2026-10-01' }], (x) => x.d, '2026-11-02', '2026-11-05'),
  [{ date: '2026-11-02', count: 0 }, { date: '2026-11-03', count: 2 }, { date: '2026-11-04', count: 0 }, { date: '2026-11-05', count: 1 }]);

// The printable page: starts with the sheet div, shows the counts, survives a report with missing parts.
import { reportHtml } from '../lib/overview.mjs';
const doc = (portal) => ({ yesterday: { date: '2026-11-04', counts: { all: 5, open: 1, overdue: 0, closed: 4, returned: 0, cancelled: 0 }, missing: { all: 1, missing: 1, closed: 0 }, portal },
  week: { from: '2026-10-29', to: '2026-11-04', missing: 3, byDay: [{ date: '2026-11-03', count: 3 }] } });
const R = { company: 'Co', from: '2026-04-01', builtAt: '2026-11-05T06:00:00.000Z', errors: { stock: 'x' }, test: true, ewb: doc({ checked: false }), einv: doc(null),
  sales: { office: 'chennai', months: [{ month: '2026-04', orders: 10, missing: 2 }], orders: 10, missing: 2, errors: [{ range: 'a to b', message: 'timeout' }] },
  invoices: { type: 'Sales', series: 'HPZPL2627', scanned: 100, counts: { missing: 1, tally: 2, uc: 3 }, list: [{ id: 'HPZPL2627-00005', month: 'Apr-2026' }] },
  stock: { checked: true, pending: 4, entries: 9 }, gatewayPending: { note: 'no file' },
  lastDates: { searchedDays: 120, cod: [{ name: 'BlueDart', last: { date: '20261103', number: '12', optional: false } }], gateway: [{ name: 'Cashfree', last: null }] } };
const html = reportHtml(R);
assert.ok(html.startsWith('<div style="font-family:'));
for (const s of ['HPZPL2627-00005', '3 Nov 2026', 'not checked (test mode', 'TEST (the GST portal was not used)', 'last 7 days', 'Apr 2026', 'none in 120 days', 'no file']) assert.ok(html.includes(s), s);
assert.ok(!html.includes('undefined'));
console.log('overview: ok');
