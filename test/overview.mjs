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

// What needs attention: only sections with something to do; failures to read are never silent; an all-clear says so.
import { reportHtml, attention } from '../lib/overview.mjs';
const clear = { company: 'Co', from: '2026-04-01', builtAt: '2026-11-05T06:00:00.000Z', errors: {},
  ewb: { overdue: 0, notClosed: 3, warnings: [] }, einv: { overdue: 0, notClosed: 0, warnings: [] }, sales: { missing: 0, errors: [] }, invoices: { counts: { missing: 0 } },
  stock: { checked: true, pending: 0 }, gatewayPending: { missing: 0 } };
assert.deepEqual(attention(clear), { lines: [], notes: [] }, 'open but not overdue is not attention');
const clearHtml = reportHtml(clear);
assert.ok(clearHtml.startsWith('<div style="font-family:') && clearHtml.includes('Nothing needs attention'));
assert.ok(!clearHtml.includes('Missing sales') && !clearHtml.includes('Count'));

const R = { ...clear, errors: { stock: 'x' }, ewb: { overdue: 2, notClosed: 7, warnings: ['Supabase: down'] },
  sales: { missing: 12, errors: [{ range: 'a to b', message: 'timeout' }] }, invoices: { counts: { missing: 1 }, note: 'lookups failed for 2' },
  stock: { checked: false, pending: null, note: 'RMS down' }, gatewayPending: { missing: 9 } };
const A = attention(R);
assert.deepEqual(A.lines.map((l) => [l.section, l.n]), [['E-Way Bill', 2], ['Missing Sales', 12], ['Missing Invoice Numbers', 1], ['Payment Gateway', 9]]);
assert.deepEqual(A.notes, ['Could not read Stock Journals: x', 'Supabase: down', 'Missing sales is incomplete — Unicommerce failed for: a to b (timeout)', 'lookups failed for 2', 'Stock Journals could not be checked against Tally: RMS down']);
const html = reportHtml(R);
for (const x of ['E-Way Bill', 'Overdue and not closed', 'Missing Sales', 'Unicommerce orders not in Tally', 'Payment Gateway', 'Journals not posted in Tally', 'Supabase: down']) assert.ok(html.includes(x), x);
for (const x of ['e-Invoice', 'Stock Journals not posted', 'Nothing needs attention', 'COD', 'yesterday', 'undefined']) assert.ok(!html.includes(x), 'should be absent: ' + x);
assert.deepEqual(attention({ company: 'Co', from: '2026-04-01', builtAt: '2026-11-05T06:00:00.000Z' }), { lines: [], notes: [] }, 'an empty report does not throw');
console.log('overview: ok');

// FV: BOEs with no sale to HPZ is one more heading; "FV not open" is a note, not silence.
assert.deepEqual(attention({ ...clear, fvSales: { unsold: 3 } }).lines, [{ section: 'No Sales Transfer Made to HPZ', label: 'BOEs not yet sold to Headphone Zone', n: 3 }]);
assert.deepEqual(attention({ ...clear, fvSales: { unsold: 0 } }), { lines: [], notes: [] });
assert.deepEqual(attention({ ...clear, fvSales: { unsold: null, note: 'Ferrari Video is not open in Tally' } }).notes, ['Ferrari Video is not open in Tally']);

// The last two working days (no Sundays): Saturday 28 Nov -> 26, 27; Monday -> Friday and Saturday; Sunday -> Friday and Saturday.
import { lastWorkingDays, windowText, isoOfOrder } from '../lib/overview.mjs';
assert.deepEqual(lastWorkingDays('2026-11-28'), ['2026-11-26', '2026-11-27']);
assert.deepEqual(lastWorkingDays('2026-11-30'), ['2026-11-27', '2026-11-28']);
assert.deepEqual(lastWorkingDays('2026-11-29'), ['2026-11-27', '2026-11-28']);
assert.deepEqual(lastWorkingDays('2026-12-01'), ['2026-11-28', '2026-11-30']);
assert.deepEqual(lastWorkingDays('2026-12-02'), ['2026-11-30', '2026-12-01']);
assert.equal(windowText({ days: ['2026-11-26', '2026-11-27'] }), '26–27 Nov');
assert.equal(windowText({ days: ['2026-11-30', '2026-12-01'] }), '30 Nov – 1 Dec');
assert.equal(isoOfOrder('27-11-2026 10:00'), '2026-11-27'); assert.equal(isoOfOrder('x'), '');
const win = attention({ ...clear, window: { days: ['2026-11-26', '2026-11-27'] }, sales: { missing: 4, errors: [] }, stock: { checked: true, pending: 2 }, invoices: { counts: { missing: 1 } } });
assert.deepEqual(win.lines.map((l) => l.label), ['Unicommerce orders not in Tally (26–27 Nov)', 'Invoice numbers missing (26–27 Nov)', 'Not posted in Tally (26–27 Nov)']);

// Missing invoice numbers: with a window only the gaps that can fall on those days are kept (a gap lies between the voucher before and after it).
import { analyze } from '../lib/missing.mjs';
const v = (no, date) => ({ no, date, type: 'Sales', cancelled: false });
const base = { from: '2026-11-20', to: '2026-11-28', vouchers: [v('HPZ2627-00001', '20261124'), v('HPZ2627-00003', '20261124'), v('HPZ2627-00004', '20261126'), v('HPZ2627-00006', '20261126'), v('HPZ2627-00007', '20261127'), v('HPZ2627-00009', '20261127')] };
const all = await analyze(base, {});
assert.deepEqual(all.rows.map((r) => r.id), ['HPZ2627-00002', 'HPZ2627-00005', 'HPZ2627-00008']);
const some = await analyze(base, { window: { from: '20261126', to: '20261127' } });
assert.deepEqual(some.rows.map((r) => r.id), ['HPZ2627-00005', 'HPZ2627-00008']);   // 00002 is between two 24 Nov vouchers
console.log('overview window: ok');
