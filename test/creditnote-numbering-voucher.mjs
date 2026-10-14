// Offline checks: credit-note numbering, units already credited, and the voucher JSON's balance.
//   node test/creditnote-numbering-voucher.mjs
import assert from 'node:assert/strict';
import { nextCreditNoteNumber, numbersOfOrder, creditedUnitsBySku, unmatchedCreditedLines, buildCreditNoteVoucher, computeCreditNote } from '../lib/creditnote.mjs';

// Numbering: the order number first, then -1, -2 … ; numbers of both credit-note types count.
assert.equal(nextCreditNoteNumber('1164862', new Set()), '1164862');
assert.equal(nextCreditNoteNumber('1164862', new Set(['1164862'])), '1164862-1');
assert.equal(nextCreditNoteNumber('1164862', new Set(['1164862', '1164862-1'])), '1164862-2');
assert.equal(nextCreditNoteNumber('1164862', new Set(['1164862', '1164862-2'])), '1164862-1');   // a gap is reused
assert.deepEqual(numbersOfOrder('116486', new Set(['116486', '116486-1', '1164862', '116486-X', 'HPZPL2627-116486'])).sort(), ['116486', '116486-1']);

// Units already credited, by SKU, from existing credit notes' item names.
const rows = [{ item: 'TRN MT1', sku: 'TRN-MT1' }, { item: 'Moondrop Chu II', sku: 'MOON-CHU' }];
assert.deepEqual(creditedUnitsBySku([{ items: [{ item: 'TRN MT1', qty: 1 }] }, { items: [{ item: 'trn mt1', qty: 1 }, { item: 'Other', qty: 3 }] }], rows), { 'trn-mt1': 2 });

// A second return of the same SKU is refused once the sold units are used up.
const uc = {
  cod: false, customer_gstin: '', notification_email: 'b@x.com',
  billing: { name: 'B', line: '1 St', state_code: 'KA', state_name: 'Karnataka', pincode: '560001' }, shipping: null,
  packages: [{ code: 'P1', invoice_display_code: 'HPZPL2627-1', invoice_date: '2026-09-20T10:00:00.000Z', customer: 'b@x.com' }],
  items: [1, 2].map(() => ({ sku: 'TRN-MT1', package_code: 'P1', selling_price: 199, selling_price_ex_tax_and_discount: 168.64, discount: 0, cgst: 0, sgst: 0, igst: 30.36, cgst_pct: 0, sgst_pct: 0, igst_pct: 18, cod_charges: 0 })),
};
const ok1 = computeCreditNote({ rows: [{ rma_number: 'R1', sku: 'TRN-MT1', item: 'TRN MT1', qty: 1 }], uc, creditedUnits: { 'trn-mt1': 1 } });
assert.ok(ok1.ok, 'second unit of two may be credited');
const no2 = computeCreditNote({ rows: [{ rma_number: 'R2', sku: 'TRN-MT1', item: 'TRN MT1', qty: 1 }], uc, creditedUnits: { 'trn-mt1': 2 } });
assert.ok(!no2.ok && /2 sold and 2 already credited/.test(no2.problems[0]), 'a third unit is refused');

// An earlier credit note under a name Tally spells differently (order 1182303: Tally "Orange - 8GB" for
// Unicommerce "Orange - 4GB", same SKU). Its unit still counts: no "-1" note for the same return.
const echo = { ...uc, items: [{ ...uc.items[0], sku: 'Snowsky-ECHO-Orange', name: 'FiiO - Snowsky - ECHO - Orange - 4GB - Audio Player' }] };
const echoRow = { rma_number: 'R3', sku: 'Snowsky-ECHO-Orange', item: 'FiiO - Snowsky - ECHO - Orange - 4GB - Audio Player', qty: 1 };
const echoNotes = [{ voucherNumber: '1182303', items: [{ item: 'FiiO - Snowsky - ECHO - Orange - 8GB - Audio Player', qty: 1 }] }];
const unmatched = unmatchedCreditedLines(echoNotes, [echoRow], echo.items);
assert.deepEqual(unmatched, [{ voucher_number: '1182303', item: 'FiiO - Snowsky - ECHO - Orange - 8GB - Audio Player', qty: 1 }]);
const echo1 = computeCreditNote({ rows: [echoRow], uc: echo, creditedUnits: creditedUnitsBySku(echoNotes, [echoRow], echo.items), unmatched });
assert.ok(!echo1.ok && /1 unit\(s\) sold on this order and 1 already credited/.test(echo1.problems[0]), 'renamed item already credited');
// Same unmatched line, but the order has a second, different item still to credit: a person must look.
const two = { ...echo, items: [...echo.items, { ...uc.items[0], sku: 'TRN-MT1', name: 'TRN MT1' }] };
const trnRow = { rma_number: 'R4', sku: 'TRN-MT1', item: 'TRN MT1', qty: 1 };
const echo2 = computeCreditNote({ rows: [trnRow], uc: two, unmatched: unmatchedCreditedLines(echoNotes, [echoRow, trnRow], two.items) });
assert.ok(!echo2.ok && /matches no item of this order by name/.test(echo2.problems[0]) && !/already credited/.test(echo2.problems[0]), 'unknown earlier line blocks a new note');
// A name that matches a Unicommerce item (not an RMS row) is placed by SKU, not left unmatched.
assert.deepEqual(unmatchedCreditedLines([{ voucherNumber: '1', items: [{ item: 'tRN  mt1', qty: 1 }] }], [], two.items), []);

// The voucher balances: party credit = item debits + tax + COD; country India on both fields.
const v = buildCreditNoteVoucher({ voucherNumber: '1199999-1', date: '2026-10-08', orderNo: '1199999', note: ok1.note });
const cr = Number(v.ledgerentries[0].amount);
const dr = v.ledgerentries.slice(1).reduce((s, l) => s + Number(l.amount), 0) + v.allinventoryentries.reduce((s, i) => s + Number(i.amount), 0);
assert.equal(Math.round((cr + dr) * 100), 0, `voucher does not balance: Cr ${cr}, Dr ${dr}`);
assert.equal(v.countryofresidence, 'India'); assert.equal(v.consigneecountryname, 'India');
assert.equal(v.vouchernumber, '1199999-1'); assert.equal(v.ledgerentries[0].billallocations[0].name, '1199999');
assert.equal(v.date, '20261008'); assert.equal(v.referencedate, '20260920'); assert.equal(v.gstnatureofreturn, '01-Sales Return');
console.log('all numbering / units / voucher checks pass');
console.log(JSON.stringify(v, null, 1).slice(0, 1400));
