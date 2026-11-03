// Offline check: the costing of BOE 4586997 equals the BOE Costing Portal's sheet (seen 2026-11-03):
//   Mojo 2 +2% 106,304.95 / total 212,609.90; Hugo 2 24,693.07 / 493,861.41; spares 1,505.34 x2; Poly PCB 18,816.87;
//   expenses 24,124 = freight 13,486 + insurance 638 + clearance 10,000.
//   node test/costing.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { costBoe, expensePool } from '../lib/costing.mjs';

const { boe, items } = JSON.parse(readFileSync(new URL('./fixtures/boe-4586997.json', import.meta.url), 'utf8'));
const c = costBoe({ boe, items });

assert.equal(c.pool.total, 24124);
assert.equal(c.pool.clearance, 10000);
assert.deepEqual(c.rows.map((r) => r.costPerPiece.toFixed(2)), ['104220.54', '24208.89', '1475.82', '1475.82', '18447.91']);
assert.deepEqual(c.rows.map((r) => r.rate.toFixed(2)), ['106304.95', '24693.07', '1505.34', '1505.34', '18816.87']);
assert.deepEqual(c.rows.map((r) => r.amount.toFixed(2)), ['212609.90', '493861.41', '1505.34', '1505.34', '18816.87']);
assert.equal(c.rows[1].qty, 20);

// An operator-entered value wins over the BOE's / the default; a nil BCD falls back to the licence-foregone amount.
assert.equal(expensePool(boe, { clearing_charges: 15000, bank_charges: 500 }).total, 13486 + 638 + 15000 + 500);
assert.equal(expensePool(boe, { clearing_charges: 0 }).clearance, 0);
const lic = costBoe({ boe: { exchange_rate: 100, freight_inr: 0, insurance_inr: 0 }, items: [{ invsno: 1, itemsn: 1, unit_price_usd: 10, qty: 1, bcd: 0, bcd_forgone: 50, sws: 5 }], variable: { clearing_charges: 0 } });
assert.equal(lic.rows[0].costPerPiece, 1055);   // 1000 + 50 + 5
assert.equal(lic.rows[0].rate, 1076.1);          // x 1.02

console.log('costing: ok');
