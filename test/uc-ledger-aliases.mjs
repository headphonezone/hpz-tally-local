// Offline checks: a 5% GST order is posted to Tally's own 5% ledgers instead of being blocked.
//   node test/uc-ledger-aliases.mjs
import assert from 'node:assert/strict';
import { aliasLedgers, LEDGER_ALIASES } from '../lib/ucsales.mjs';

const note = () => ({
  lines: [{ item: 'T-shirt', ledger: 'Interstate GST5.0%' }],
  tax: [{ ledger: 'Output IGST @5%', amount: 5 }],
  charges: [{ ledger: 'COD Charges', amount: 50 }],
});
const local = () => ({
  lines: [{ item: 'T-shirt', ledger: 'Local GST5.0%' }],
  tax: [{ ledger: 'Output CGST @2.5%', amount: 2.5 }, { ledger: 'Output SGST @2.5%', amount: 2.5 }],
  charges: [],
});

// Exact names missing, Tally's spellings present: the note is pointed at them.
let n = note();
assert.deepEqual(aliasLedgers(n, new Set(['Interstate GST 5%', 'Output IGST @5%', 'COD Charges'])), [['Interstate GST5.0%', 'Interstate GST 5%']]);
assert.equal(n.lines[0].ledger, 'Interstate GST 5%');
assert.equal(n.tax[0].ledger, 'Output IGST @5%');   // already exact: untouched
assert.equal(n.charges[0].ledger, 'COD Charges');

n = local();
const changed = aliasLedgers(n, new Set(['Local GST @5%', 'Output CGST 2.50%', 'Output SGST 2.50%']));
assert.equal(changed.length, 3);
assert.deepEqual([n.lines[0].ledger, n.tax[0].ledger, n.tax[1].ledger], ['Local GST @5%', 'Output CGST 2.50%', 'Output SGST 2.50%']);

// An exact match always wins: nothing is changed when the real name exists.
n = note();
assert.deepEqual(aliasLedgers(n, new Set(['Interstate GST5.0%', 'Interstate GST 5%'])), []);
assert.equal(n.lines[0].ledger, 'Interstate GST5.0%');

// The alias missing too: left alone, so the order stays blocked as "ledger not found".
n = note();
assert.deepEqual(aliasLedgers(n, new Set()), []);
assert.equal(n.lines[0].ledger, 'Interstate GST5.0%');

// 0% has no Tally twin and is not aliased.
assert.equal(LEDGER_ALIASES['Interstate GST0.0%'], undefined);

console.log('uc-ledger-aliases: ok');
