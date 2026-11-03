// Offline checks: the FV -> Headphone Zone sale, against FV's real FVC/26-27/0175 (31-Oct-2026, read from Tally 2026-11-03).
//   node test/fv-sale.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { templateFrom, nextNumber, computeSale, buildSaleVoucher, compareSale } from '../lib/fvsale.mjs';

const real = JSON.parse(readFileSync(new URL('./fixtures/fv-sale-0175.json', import.meta.url), 'utf8'));

// The layout is read off the voucher.
const { template, problems } = templateFrom(real);
assert.equal(problems, undefined);
assert.equal(template.party, 'Headphone Zone Private Limited');
assert.equal(template.salesLedger, 'Sale GST');
assert.equal(template.godown, 'Chennai Wh -Good');
assert.deepEqual([template.cgst.ledger, template.cgst.pct, template.sgst.ledger, template.sgst.pct], ['Output CGST @9%', 9, 'Output SGST @9%', 9]);
assert.deepEqual(template.tds, { ledger: 'Tds Receivable on Sale', pct: 0.1 });
assert.equal(template.rounding, 'Rounding Off');
assert.equal(template.placeOfSupply, 'Tamil Nadu');
assert.deepEqual(templateFrom({ ...real, ledgers: real.ledgers.filter((l) => !/^tds|round/i.test(l.ledger)) }).template.tds, null);
assert.ok(templateFrom({ ...real, ledgers: real.ledgers.filter((l) => !/^output/i.test(l.ledger)) }).problems.length);

// The money, recomputed from the voucher's own lines, equals what Tally holds.
const sale = computeSale(real.items.map((i) => ({ item: i.item, qty: i.qty, rate: i.rate })), template);
assert.equal(sale.taxable, 726635.69);
assert.equal(sale.cgst, 65397.22);       // GST rounded per line: 9% of the total would be 65,397.21
assert.equal(sale.sgst, 65397.22);
assert.equal(sale.tds, 727);
assert.equal(sale.rounding, -0.13);
assert.equal(sale.party, 856703);

// The voucher: balanced, and a Tally read-back of it matches (a changed amount or a missing line does not).
const v = buildSaleVoucher({ template, number: 'FVC/26-27/0176', date: '20261103', sale, optional: true });
const sum = v.ledgerentries.reduce((s, l) => s + Number(l.amount), 0) + v.allinventoryentries.reduce((s, e) => s + Number(e.amount), 0);
assert.ok(Math.abs(sum) < 0.005, `voucher out of balance by ${sum}`);
assert.equal(v.ledgerentries[0].amount, '-856703.00');
assert.equal(v.ledgerentries[0].billallocations[0].name, 'FVC/26-27/0176');
assert.equal(v.isoptional, true);
assert.equal(buildSaleVoucher({ template, number: 'X', date: '20261103', sale }).isoptional, undefined);
assert.equal(v.vouchernumber, 'FVC/26-27/0176');
assert.equal(v.allinventoryentries[0].batchallocations[0].godownname, 'Chennai Wh -Good');
assert.equal(v.allinventoryentries[0].accountingallocations[0].ledgername, 'Sale GST');
const back = { ledgers: real.ledgers, items: real.items };
const sameAsReal = buildSaleVoucher({ template, number: real.number, date: real.date, sale });
assert.deepEqual(compareSale(sameAsReal, back), []);
assert.ok(compareSale(sameAsReal, { ...back, items: back.items.slice(1) }).length);
assert.ok(compareSale(sameAsReal, { ...back, ledgers: back.ledgers.map((l) => (l.ledger === 'Output CGST @9%' ? { ...l, amount: 1 } : l)) }).length);

// Numbering: the next of the template's series, past every number taken (also numbers of other parties).
assert.equal(nextNumber('FVC/26-27/0175', new Set(['FVC/26-27/0174', 'FVC/26-27/0175'])), 'FVC/26-27/0176');
assert.equal(nextNumber('FVC/26-27/0175', new Set(['FVC/26-27/0178', 'OTHER/0200', '1186'])), 'FVC/26-27/0179');
assert.equal(nextNumber('FVC/26-27/0999', new Set()), 'FVC/26-27/1000');
assert.equal(nextNumber('no digits', new Set()), null);

// No TDS in the template: no TDS line, rounding still to the rupee.
const noTds = computeSale([{ item: 'A', qty: 3, rate: 33.33 }], { ...template, tds: null });
assert.deepEqual([noTds.taxable, noTds.cgst, noTds.tds, noTds.party], [99.99, 9, 0, 118]);   // 99.99 + 9.00 + 9.00 = 117.99

console.log('fv-sale: ok');

// --- sale only: lines taken from the purchase already in Tally (BOE 4586997's lines and costing) ---
import { linesFromPurchase, holdsAll } from '../lib/fvsale.mjs';
import { costBoe } from '../lib/costing.mjs';
{
  const { boe, items } = JSON.parse(readFileSync(new URL('./fixtures/boe-4586997.json', import.meta.url), 'utf8'));
  const rateOf = new Map(costBoe({ boe, items }).rows.map((r) => [r.key, r]));
  const boeLines = items.map((i) => ({ key: `${i.invsno}-${i.itemsn}`, invsno: i.invsno, itemsn: i.itemsn, description: i.description, price: i.unit_price_usd, qty: i.qty }));
  // As the purchase voucher holds them: Tally's names, the two $10 remote controls in the other order.
  const bought = [
    { item: 'Chord - Mojo 2 - Black', qty: 2, price: 673.31 },
    { item: 'Chord - Hugo2/TT2 remote control - Accessory', qty: 1, price: 10 },
    { item: 'Chord - Hugo M Scaler Remote Control - Accessory', qty: 1, price: 10 },
    { item: 'Chord - Hugo 2 - Black', qty: 20, price: 156.4 },
    { item: 'Chord - Poly PCB Board - Accessory', qty: 1, price: 125 },
  ];
  const r = linesFromPurchase(bought, boeLines, rateOf);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.lines.map((l) => [l.item, l.qty, l.rate]), [
    ['Chord - Mojo 2 - Black', 2, 106304.95], ['Chord - Hugo2/TT2 remote control - Accessory', 1, 1505.34],
    ['Chord - Hugo M Scaler Remote Control - Accessory', 1, 1505.34], ['Chord - Hugo 2 - Black', 20, 24693.07], ['Chord - Poly PCB Board - Accessory', 1, 18816.87]]);
  assert.equal(r.lines[1].key, '2-2');   // the TT2 remote went to its own BOE line, not the Scaler one
  assert.equal(r.lines[2].key, '2-1');

  // A purchase that does not fit the BOE is reported, not guessed.
  assert.ok(linesFromPurchase([{ item: 'X', qty: 2, price: 99 }], boeLines, rateOf).problems.some((p) => /fits no BOE line/.test(p)));
  assert.ok(linesFromPurchase(bought.slice(0, 3), boeLines, rateOf).problems.some((p) => /not on the purchase/.test(p)));

  // An existing sale is recognised only when it holds ALL the items in these quantities (so a sale from older stock is not one).
  const sale = r.lines.map((l) => ({ item: l.item, qty: l.qty }));
  assert.equal(holdsAll(sale, [...sale.map((l) => ({ ...l, item: l.item.toUpperCase() })), { item: 'Other', qty: 5 }]), true);
  assert.equal(holdsAll(sale, sale.slice(1)), false);
  assert.equal(holdsAll(sale, sale.map((l) => ({ ...l, qty: l.qty + 1 }))), false);
  assert.equal(holdsAll([], sale), false);
}
console.log('fv-sale (sale only): ok');
