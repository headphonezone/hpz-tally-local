// node test/cod-formats.mjs — the DTDC and Delhivery COD file formats (no Tally): column names as in the Streamlit tool
// (github.com/headphonezone/HPZ_COD_Automation), DTDC AWBs with letters, only Remitted DTDC rows, the Delhivery date typed in.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as cod from '../lib/cod.mjs';

const book = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s'); for (const r of rows) ws.addRow(r); return Buffer.from(await wb.xlsx.writeBuffer()); };

// DTDC
const dtdc = await cod.parseFile(await book([
  ['CN Number', 'COD Amount', 'Remittance Status', 'Remittance Date', 'UTR Number', 'Sale Order Number'],
  ['7X117074453', '2,398.00', 'Remitted', '28-10-2026', 'UTR1', '#1188766'],
  ['i12345678', 1500, 'remitted', new Date('2026-10-27T00:00:00Z'), 'UTR1', ''],
  ['7X117074448', 999, 'Pending', '', '', ''],
  ['7X117074453', 2398, 'Remitted', '28-10-2026', 'UTR1', ''],
  ['TOTAL', 3898, '', '', '', ''],
]), 'dtdc.xlsx');
assert.equal(dtdc.courier, 'DTDC'); assert.equal(dtdc.drLedger, 'DTDC EXPRESS Receivable');
assert.deepEqual(dtdc.rows.map((r) => r.awb), ['7X117074453', 'I12345678'], 'upper-cased; letters allowed');
assert.equal(dtdc.rows[0].amount, 2398); assert.equal(dtdc.rows[0].payDate, '2026-10-28'); assert.equal(dtdc.rows[1].payDate, '2026-10-27');
assert.equal(dtdc.notPaid, 1, 'Pending is not remitted'); assert.deepEqual(dtdc.duplicates, ['7X117074453']); assert.equal(dtdc.skipped, 1, 'the TOTAL line');
assert.ok(dtdc.rows.every((r) => r.anchorOnly && !r.pickup));

// Delhivery: no date in the file
const dlBook = await book([['Order Number', 'Waybill Number', 'COD Amount'], ['#1169191', '6851210770372', 1098], ['1163710', '6851210768132.0', 2398]]);
await assert.rejects(cod.parseFile(dlBook, 'd.xlsx'), /carries no date/);
const dl = await cod.parseFile(dlBook, 'd.xlsx', { postingDate: '2026-10-12' });
assert.equal(dl.courier, 'DELHIVERY'); assert.equal(dl.drLedger, 'Delhivery COD Receivable');
assert.equal(dl.rows.length, 2); assert.ok(dl.rows.every((r) => r.payDate === '2026-10-12'));
assert.equal(dl.rows[0].ref, '#1169191');

// an unknown file
await assert.rejects(cod.parseFile(await book([['a', 'b'], [1, 2]]), 'x.xlsx'), /Known: BlueDart.*DTDC.*Delhivery/);
console.log('cod formats: all checks passed');
