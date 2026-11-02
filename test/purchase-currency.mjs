// node test/purchase-currency.mjs — a foreign-currency symbol outside ASCII (£) must reach Tally as a Windows-1252 byte,
// or Tally saves every amount as 0.00 (BOE 4586997, GBP, 2026-11-02). No Tally needed.
import assert from 'node:assert/strict';
import { buildPurchaseVoucher } from '../lib/purchase.mjs';
import { encodeForTally } from '../lib/tally.mjs';

const prep = (sym, code, extra = {}) => ({
  boe: { be_no: '4586997', be_date: '2026-10-22', inv_no: '29998, 30037' },
  template: { voucherType: 'Purchase Import', godown: 'Chennai Wh -Good', batch: 'Primary Batch', purchaseLedger: 'Import Purchase' },
  party: 'Chord Electronics Ltd', freight: null, currency: { sym, code },
  narration: `BOE no: 4586997  BE dt: 22/10/2026  ${code} ${sym}4619.62   ₹127.95`,
  totals: { invoiceUsd: 4619.62, rate: 127.95 },
  lines: [{ price: 673.31, tally: [{ item: 'Chord - Mojo 2 - 2026 - Headphone Amplifier', qty: 2, amount: 1346.62 }] },
    { price: 10, tally: [{ item: 'Chord - Poly PCB Board - Accessory', qty: 1, amount: 3273 }] }],
  ...extra,
});

// GBP: the whole request is Windows-1252 — the pound sign is the single byte A3, never C2 A3 — and the amounts carry it
const gbp = buildPurchaseVoucher(prep('£', 'GBP'), { optional: true });
assert.ok(!gbp.narration.includes('₹'), 'no rupee sign next to a £ amount');
assert.match(gbp.narration, /Rs\. 127\.95$/);
const bytes = encodeForTally(JSON.stringify(gbp));
assert.ok(bytes.includes(0xa3), 'the pound sign goes as byte A3');
assert.ok(!bytes.includes(Buffer.from([0xc2, 0xa3])), 'and not as UTF-8 C2 A3');
assert.match(gbp.ledgerentries[0].amount, /^£4619\.62 @ Rs\. 127\.95\/£ = Rs\. \d+\.\d\d$/);
assert.equal(gbp.allinventoryentries[0].amount, '-£1346.62 @ Rs. 127.95/£ = -Rs. 172300.03');

// USD (U$ is ASCII): unchanged — the rupee sign stays in the narration
const usd = buildPurchaseVoucher(prep('U$', 'USD'));
assert.match(usd.narration, /₹127\.95$/);

// a name Windows-1252 cannot carry would turn the request to UTF-8: refuse, do not post zero amounts
const bad = prep('£', 'GBP'); bad.lines[0].tally[0].item = 'Chord - 莫乔';
assert.throws(() => buildPurchaseVoucher(bad), /Windows-1252/);
// …which does not matter for an ASCII symbol
const ok = prep('U$', 'USD'); ok.lines[0].tally[0].item = 'Chord - 莫乔';
assert.doesNotThrow(() => buildPurchaseVoucher(ok));

console.log('purchase currency: all checks passed');
