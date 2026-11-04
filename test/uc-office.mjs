// Offline checks: Chennai and Mumbai-office sales are told apart by the report's Billing Party Code (HZM = Mumbai), and a Mumbai sale is built for the
// Mumbai company (its godown, its sales-ledger names).
//   node test/uc-office.mjs
import assert from 'node:assert/strict';
import { groupOrders } from '../lib/uc.mjs';
import { orderOffice, officeOfCompany, GODOWN, aliasesOf, aliasLedgers, buildSalesVoucher, computeSalesOrder } from '../lib/ucsales.mjs';

// Which office an order belongs to: from the Billing Party Code of its lines.
const line = (inv, god, extra = {}) => ({ 'Invoice number': inv, 'Sale Order Number': `SO-${inv}`, Date: '03-11-2026', 'Customer Email': 'a@b.com', 'Customer Name': 'A', 'Billing Party Code': god,
  'Product Name': 'Chord - Mojo 2', Qty: '1', 'Unit Price': '100', Sales: '100', 'Sales Ledger': 'Local GST18.0%', 'CGST': '9', 'CGST Rate': 'CGST9.0%', 'SGST': '9', 'SGST Rate': 'SGST9.0%', Total: '118', ...extra });
const orders = groupOrders([line('C1', 'WAREHOUSE'), line('M1', 'HZM'), line('M2', 'hzm'), line('X1', 'WAREHOUSE'), line('X1', 'HZM'), line('N1', ''), line('H2', 'HZMX')]);
const by = Object.fromEntries(orders.map((o) => [o.invoice, o]));
assert.deepEqual(by.C1.partyCodes, ['WAREHOUSE']);
assert.equal(orderOffice(by.C1), 'chennai');
assert.equal(orderOffice(by.M1), 'mumbai');
assert.equal(orderOffice(by.M2), 'mumbai');
assert.equal(orderOffice(by.X1), 'mixed');       // lines with both offices' codes: booked nowhere
assert.equal(orderOffice(by.H2), 'chennai');     // only HZM itself is Mumbai
assert.equal(orderOffice(by.N1), 'chennai');     // no code at all: as before this change
assert.equal(orderOffice({}), 'chennai');

// Which office the open Tally company is.
assert.equal(officeOfCompany('Headphone Zone Pvt Ltd Mumbai - (from 1-Apr-26)'), 'mumbai');
assert.equal(officeOfCompany('Headphone Zone Pvt Ltd Chennai - (from 1-Apr-26)'), 'chennai');
assert.equal(officeOfCompany('Ferrari Video Chennai - (from 1-Apr-26)'), 'chennai');
assert.equal(GODOWN, 'Home Location');

// The Mumbai company spells the sales ledgers "Local Sale @18.0%" / "Interstate Sale @5.0%".
assert.deepEqual(aliasesOf('Local GST18.0%'), ['Local Sale @18.0%']);
assert.deepEqual(aliasesOf('Interstate GST18.0%'), ['Interstate Sale @18.0%']);
assert.deepEqual(aliasesOf('Interstate GST5.0%'), ['Interstate GST 5%', 'Interstate Sale @5.0%']);
assert.deepEqual(aliasesOf('Output IGST @18%'), []);
const mumbaiLedgers = new Set(['Local Sale @18.0%', 'Interstate Sale @18.0%', 'Output CGST @9%', 'Output SGST @9%', 'Output IGST @18%']);
const note = { lines: [{ item: 'A', ledger: 'Local GST18.0%' }, { item: 'B', ledger: 'Interstate GST18.0%' }], tax: [{ ledger: 'Output CGST @9%' }], charges: [] };
assert.equal(aliasLedgers(note, mumbaiLedgers).length, 2);
assert.deepEqual(note.lines.map((l) => l.ledger), ['Local Sale @18.0%', 'Interstate Sale @18.0%']);
// Chennai is untouched: its exact ledger exists, so no alias is used.
const chennai = { lines: [{ item: 'A', ledger: 'Local GST18.0%' }], tax: [], charges: [] };
assert.deepEqual(aliasLedgers(chennai, new Set(['Local GST18.0%', 'Local Sale @18.0%'])), []);
assert.equal(chennai.lines[0].ledger, 'Local GST18.0%');
// Nothing present under any name: left alone (stays blocked as "ledger not found").
const none = { lines: [{ item: 'A', ledger: 'Local GST18.0%' }], tax: [], charges: [] };
assert.deepEqual(aliasLedgers(none, new Set()), []);

// The voucher takes the company's godown.
const c = computeSalesOrder(by.M1);
assert.ok(c.ok, c.problems.join('; '));
assert.equal(buildSalesVoucher({ voucherNumber: 'M1', date: '20261103', note: c.note }).allinventoryentries[0].batchallocations[0].godownname, 'Home Location');

console.log('uc-office: ok');
