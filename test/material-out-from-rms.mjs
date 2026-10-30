// Offline checks: the Material Out tab built from the WCIDs closed in RMS (book 'rms'), with a stand-in
// Tally and a canned RMS answer.
//   node test/material-out-from-rms.mjs
import assert from 'node:assert/strict';

process.env.RMS_API_URL = 'http://rms.test';
process.env.RMS_AGENT_SECRET = 'test-secret';
const { buildReport } = await import('../lib/report.mjs');
const { applyReplacements } = await import('../lib/replacements.mjs');

const X = '1MORE - Piston Fit - 3.5mm - Silver - In-ear Headphone';
const Y = '1MORE - Piston Fit - 3.5mm - Grey - In-ear Headphone';
const units = new Map([[X, 'Nos'], [Y, 'Nos']]);

const closed = (wcid, decision, o = {}) => ({ wcid, rma_number: `RMA-${wcid}`, product_name: X, customer_name: `Customer ${wcid}`,
  current_godown: null, decision, closure_date: '2026-10-21T05:00:00.000Z', dispatched: true, awb: `AWB-${wcid}`, closure_day: '2026-10-21', ...o });
const cases = [
  closed('R1', 'Repair'),                                        // repaired: the same unit, from the Material In's godown
  closed('R2', 'Repair', { current_godown: 'Def', closure_day: '2026-10-22' }),   // a journal moved it to Def: out from Def
  closed('R3', null, { current_godown: 'Service Godown' }),      // no decision (working fine): the same unit
  closed('SC', 'Store credit'),                                  // nothing went back: held
  closed('SU', 'Working Replacement'),                           // replacement not logged in Movement of Stock: held
  closed('RP1', 'New Replacement'),                              // replacement logged: the unit sent
  closed('DONE', 'Repair'),                                      // already has its Material Out
  closed('OLD', 'Repair'),                                       // Material In older than the lookback
  closed('NOMI', 'Repair'),                                      // no Material In in this company
];

let asked;
globalThis.fetch = async (url, opts) => {
  asked = { url: String(url), secret: opts.headers['x-agent-secret'] };
  return new Response(JSON.stringify({ from: '2026-10-15', to: '2026-10-22', cases }), { status: 200 });
};

const mi = (n) => ({ voucherNumber: n, date: '20261001', party: `Party ${n}`, narration: `Received ${n}`,
  inventoryIn: [{ stockItem: X, actualQty: ' 1.0 Nos', godown: 'Service Godown', batchName: 'Primary Batch' }] });
const tally = {
  activeCompany: async () => 'Test Company',
  vouchersOfType: async (type, o) => {
    assert.equal(type, 'Material In');
    assert.deepEqual([o.from, o.to], ['20260715', '20261022']);   // three months of lookback
    return ['R1', 'R2', 'R3', 'SC', 'SU', 'RP1', 'DONE'].map(mi);
  },
  voucherNumbersOfType: async (type) => (type === 'Material In' ? ['R1', 'R2', 'R3', 'SC', 'SU', 'RP1', 'DONE', 'OLD'] : ['DONE_MO']),
};

const report = await buildReport({ book: 'rms', from: '20261015', to: '20261022' }, tally);
assert.equal(asked.url, 'http://rms.test/api/stock-journal-link/material-outs?from=2026-10-15&to=2026-10-22');
assert.equal(asked.secret, 'test-secret');
assert.equal(report.totals.sheetRows, cases.length);
const by = Object.fromEntries(report.rows.map((r) => [r.wcid, r]));

// The closure day is the Material Out's date, shown like the sheet's.
assert.equal(by.R1.tallyDate, '20261021');
assert.equal(by.R1.sheetDate, '21-Oct-2026');
assert.equal(by.R2.tallyDate, '20261022');
assert.equal(by.R1.customer, 'Customer R1');
assert.equal(by.R1.source, 'RMS');
assert.deepEqual(by.R1.rms, { decision: 'Repair', godown: '', awb: 'AWB-R1' });

assert.equal(by.R1.status, 'ready');
assert.equal(by.R1.out, undefined);                                 // the Material In's own item and godown
assert.equal(by.R2.status, 'ready');
assert.deepEqual(by.R2.out, { ...by.R2.mi, godown: 'Def' });
assert.equal(by.R2.out.stockItem, X);
assert.equal(by.R3.status, 'ready');
assert.equal(by.R3.out, undefined);                                 // already in the Material In's godown
assert.equal(by.SC.status, 'blocked');
assert.match(by.SC.reason, /Store credit/);
assert.equal(by.DONE.status, 'done');
assert.equal(by.OLD.status, 'blocked');
assert.match(by.OLD.reason, /outside the 3-month lookback/);
assert.equal(by.NOMI.status, 'blocked');
assert.match(by.NOMI.reason, /no Material In numbered NOMI/);
assert.equal(by.SU.status, 'ready');                                // replacements are settled next
assert.equal(by.SU.out, undefined);

// Then RMS Movement of Stock: the unit sent for RP1, and SU still waiting for its entry.
applyReplacements(report, {
  replacements: [{ movement_id: 'm-RP1', wcid: 'RP1', condition: 'Replacement from Chennai', item_received: X, item_sent: Y,
    sent_unboxed: false, send_godown: 'Chennai Wh -Good', source_ref_no: null, material_out_no: null }],
  awaiting: ['SU'], units, alias: () => null,
});
assert.equal(by.RP1.out.stockItem, Y);
assert.equal(by.RP1.out.godown, 'Chennai Wh -Good');
assert.equal(by.SU.status, 'blocked');
assert.match(by.SU.reason, /not logged in RMS Movement of Stock/);
assert.deepEqual(report.counts, { ready: 4, done: 1, blocked: 4 });

// An RMS that answers with an error stops the build with RMS's message, even when it answers while Tally
// is still being read (an unawaited rejection would end the process).
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
const slowTally = { ...tally, activeCompany: () => new Promise((resolve) => setTimeout(() => resolve('Test Company'), 50)) };
await assert.rejects(buildReport({ book: 'rms', from: '20261015', to: '20261022' }, slowTally), /Unauthorized/);

console.log('material-out-from-rms: all checks passed');
