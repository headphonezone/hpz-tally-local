// Offline checks: the narration of a Movement of Stock journal, with and without RMS's "unit in Mumbai" tick.
//   node test/movement-narration.mjs
import assert from 'node:assert/strict';
import { caseNarration, isUnitInMumbai, narrationNames } from '../lib/stockjournal.mjs';

// Unticked: the narration is exactly what it always was.
assert.equal(caseNarration({ reference: 'RET78162', unit_in_mumbai: false }), 'RET78162');
assert.equal(caseNarration({ reference: 'RET78162' }), 'RET78162');
assert.equal(caseNarration({ reference: 'RET1', source_ref_no: 'RET2', unit_in_mumbai: false }), 'RET1 replaced by RET2');

// Ticked: " - Unit in Mumbai" goes after the old narration.
assert.equal(caseNarration({ reference: 'RET78162', unit_in_mumbai: true }), 'RET78162 - Unit in Mumbai');
assert.equal(caseNarration({ reference: 'RET1', source_ref_no: 'RET2', unit_in_mumbai: true }), 'RET1 replaced by RET2 - Unit in Mumbai');
assert.equal(caseNarration({ reference: 'RMA-2026-10208', unit_in_mumbai: 'true' }), 'RMA-2026-10208 - Unit in Mumbai');

// Only a real tick counts.
for (const v of [false, 'false', 0, '0', null, undefined, '']) assert.equal(isUnitInMumbai({ unit_in_mumbai: v }), false, String(v));
for (const v of [true, 'true', 1, '1']) assert.equal(isUnitInMumbai({ unit_in_mumbai: v }), true, String(v));

// The RET is still found in the narration (the "already in Tally" check), and RET7305 is still not RET73051.
assert.ok(narrationNames(caseNarration({ reference: 'RET78162', unit_in_mumbai: true }), 'RET78162'));
assert.ok(!narrationNames(caseNarration({ reference: 'RET73051', unit_in_mumbai: true }), 'RET7305'));

console.log('movement-narration: ok');
