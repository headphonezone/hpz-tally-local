// Offline checks: a stock item name with a non-ASCII mark goes to Tally as pure ASCII (\uXXXX) in the voucher JSON.
//   node test/item-name-encoding.mjs
import assert from 'node:assert/strict';

const { escapeItemNames } = await import('../lib/tally.mjs');

const name = 'Dekoni Audio - Presplit - 4.4mm plug+Y Splitter - 64” length - Silver Braided Cable - CBZ-HP-64-TW-4.4 - Accessory';
const json = JSON.stringify({ tallymessage: [{ narration: 'café “x”', allinventoryentries: [{ stockitemname: name, rate: '1/Nos' }] }] });
const out = escapeItemNames(json);

assert.ok(out.includes('64\\u201d length'));
assert.ok(!/[^\x00-\x7f]/.test(out.match(/"stockitemname":"[^"]*"/)[0]));
assert.deepEqual(JSON.parse(out).tallymessage[0].allinventoryentries[0].stockitemname, name);   // the same name once parsed
assert.ok(out.includes('café “x”'));                                              // nothing else is touched

// An escaped quote inside a name, and a plain name, pass through unchanged.
const plain = JSON.stringify({ stockitemname: 'Hiby - R4 - Black - Audio Player' });
assert.equal(escapeItemNames(plain), plain);
const quoted = JSON.stringify({ stockitemname: 'Ensemble - 52" Silver ″' });
assert.equal(JSON.parse(escapeItemNames(quoted)).stockitemname, 'Ensemble - 52" Silver ″');

console.log('item-name-encoding: all checks passed');
