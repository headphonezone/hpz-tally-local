// Offline checks: a replaced WCID's Material Out carries the unit actually sent, from the godown it left.
//   node test/replacement-material-out.mjs
import assert from 'node:assert/strict';
import { applyReplacements, resolveItem } from '../lib/replacements.mjs';
import { materialOutVoucher } from '../lib/tally.mjs';

const X = '1MORE - Piston Fit - 3.5mm - Silver - In-ear Headphone';
const Y = '1MORE - Piston Fit - 3.5mm - Grey - In-ear Headphone';
const units = new Map([[X, 'Nos'], [Y, 'Nos'], [`Unboxed - ${Y}`, 'Nos'], ['KZ - Castor - Pro', 'Pcs'], ['No Unit Item', 'Not Applicable']]);

// Item names: exact, spacing/case differences, the unboxed item, an operator's alias, or nothing.
assert.equal(resolveItem(Y, false, units), Y);
assert.equal(resolveItem(Y, true, units), `Unboxed - ${Y}`);
assert.equal(resolveItem('1more - piston fit -3.5mm - grey - in-ear headphone', false, units), Y);
assert.equal(resolveItem('KZ CASTOR PRO (RMS name)', false, units, (n) => (n.startsWith('KZ CASTOR') ? 'KZ - Castor - Pro' : null)), 'KZ - Castor - Pro');
assert.equal(resolveItem('Unknown Product', false, units), null);

const mi = (narration = 'Received from customer') => ({ date: '20261020', party: 'Customer A', narration, stockItem: X, qty: ' 1.0 Nos', godown: 'Service Godown', batchName: 'Primary Batch' });
const row = (wcid, extra = {}) => ({ wcid, moNumber: `${wcid}_MO`, status: 'ready', reason: '', tallyDate: '20261029', mi: mi(), ...extra });
const repl = (wcid, o = {}) => ({ movement_id: `m-${wcid}`, wcid, condition: 'Replacement from Chennai', item_received: X, item_sent: Y, sent_unboxed: false, send_godown: 'Chennai Wh -Good', source_ref_no: null, material_out_no: null, ...o });

const report = { rows: [
  row('WCID1'),                                    // replaced by another model, from Chennai
  row('wcid2'),                                    // same model, from the Service Godown (a RET); WCID case differs from RMS
  row('WCID3'),                                    // unboxed unit of another model
  row('WCID4'),                                    // repaired: no replacement in RMS
  row('WCID5'),                                    // decided as a replacement, nothing logged in RMS yet
  row('WCID6'),                                    // the item sent isn't a Tally item
  row('WCID7', { status: 'done' }),                // already has its Material Out: left alone
  row('WCID8'),                                    // the item sent has no unit
] };
const n = applyReplacements(report, {
  replacements: [
    repl('WCID1'),
    repl('WCID2', { condition: 'Replacement from Service', item_sent: X, send_godown: 'Service Godown', source_ref_no: 'RET77' }),
    repl('WCID3', { condition: 'Replacement from Chennai (unboxed)', sent_unboxed: true }),
    repl('WCID6', { item_sent: 'Unknown Product' }),
    repl('WCID7'),
    repl('WCID8', { item_sent: 'No Unit Item' }),
  ],
  awaiting: ['WCID5'],
  units,
  alias: () => null,
});
const by = Object.fromEntries(report.rows.map((r) => [r.wcid.toUpperCase(), r]));

assert.deepEqual(by.WCID1.out, { stockItem: Y, qty: ' 1.0 Nos', godown: 'Chennai Wh -Good', batchName: 'Primary Batch',
  narration: `Received from customer | Replacement for WCID1: sent ${Y} from Chennai Wh -Good (customer's unit: ${X})` });
assert.equal(by.WCID1.status, 'ready');
assert.equal(by.WCID1.replacement.movementId, 'm-WCID1');
assert.equal(by.WCID2.out.stockItem, X);
assert.equal(by.WCID2.out.godown, 'Service Godown');
assert.equal(by.WCID2.out.narration, `Received from customer | Replacement for wcid2: sent ${X} from Service Godown, RET RET77`);
assert.equal(by.WCID3.out.stockItem, `Unboxed - ${Y}`);
assert.equal(by.WCID4.out, undefined);                       // repaired: its own item, as before
assert.equal(by.WCID4.status, 'ready');
assert.equal(by.WCID5.status, 'blocked');
assert.match(by.WCID5.reason, /not logged in RMS Movement of Stock/);
assert.equal(by.WCID6.status, 'blocked');
assert.match(by.WCID6.reason, /"Unknown Product" is not a Tally item/);
assert.equal(by.WCID6.out, undefined);
assert.equal(by.WCID7.out, undefined);
assert.equal(by.WCID7.status, 'done');
assert.equal(by.WCID8.status, 'blocked');
assert.match(by.WCID8.reason, /no unit/);
assert.deepEqual(report.counts, { ready: 4, done: 1, blocked: 3 });
assert.equal(n, 6);

// The voucher create.mjs builds from a row: `out` when replaced, the Material In otherwise; the party is the
// Material In's either way.
const voucherOf = (r) => { const o = r.out || r.mi; return materialOutVoucher({ wcid: r.wcid, date: r.tallyDate, party: r.mi.party, narration: o.narration, stockItem: o.stockItem, qty: o.qty, godown: o.godown, batchName: o.batchName }); };
const v3 = voucherOf(by.WCID3);
assert.equal(v3.vouchernumber, 'WCID3_MO');
assert.equal(v3.partyledgername, 'Customer A');
assert.equal(v3.inventoryentriesout[0].stockitemname, `Unboxed - ${Y}`);
assert.equal(v3.inventoryentriesout[0].batchallocations[0].godownname, 'Chennai Wh -Good');
assert.match(v3.narration, /Replacement for WCID3: sent Unboxed - /);
const v4 = voucherOf(by.WCID4);
assert.equal(v4.inventoryentriesout[0].stockitemname, X);
assert.equal(v4.inventoryentriesout[0].batchallocations[0].godownname, 'Service Godown');
assert.equal(v4.narration, 'Received from customer');

console.log('replacement-material-out: all checks passed');
