// Offline checks: a BOE item name is matched to the Tally item spelled with different punctuation, but never ambiguously.
//   node test/purchase-item-match.mjs
import assert from 'node:assert/strict';
import { looseKey, looseIndex } from '../lib/purchase.mjs';

const tally = ['Chord - Hugo M Scaler Remote Control - Accessory', 'Chord - Hugo2/TT2 remote control - Accessory', 'Chord - Hugo - TT2 - Headphone - AMP',
  'Foo - Bar - Black', 'Foo Bar - Black', 'Chord - Mojo 2 - Black'];
const find = looseIndex(tally);

// BOEs 4586997: the BOE's own spelling has one more hyphen than Tally's item.
assert.equal(find('Chord - Hugo M Scaler - Remote Control - Accessory'), 'Chord - Hugo M Scaler Remote Control - Accessory');
assert.equal(find('Chord - Hugo2/TT2 - remote control - Accessory'), 'Chord - Hugo2/TT2 remote control - Accessory');
assert.equal(find('CHORD HUGO M SCALER REMOTE CONTROL ACCESSORY'), 'Chord - Hugo M Scaler Remote Control - Accessory');

// Two Tally items that only differ by punctuation: no guess.
assert.equal(find('Foo - Bar - Black'), null);
// A genuinely different product, and an empty name: no match.
assert.equal(find('Chord - Mojo 2 - Silver'), null);
assert.equal(find('---'), null);
assert.equal(looseKey('Chord - Hugo2/TT2'), 'chordhugo2tt2');

console.log('purchase-item-match: ok');
