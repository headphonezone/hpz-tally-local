// node test/excel-table.mjs — the generic "Download Excel" workbook (tableToXlsx): header row, numbers stay numbers, sheet names made safe.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { tableToXlsx } from '../lib/excel.mjs';

const buf = await tableToXlsx({ sheets: [
  { name: 'Rows: [1]/2?', columns: ['Invoice', 'Amount', 'Qty', 'Note'], rows: [['A1', 2398.5, 2, 'ok'], ['A2', 100, 1], ['=SUM(A1)', NaN, null, 'x'.repeat(40000)]] },
  { name: 'Rows: [1]/2?', columns: ['Only'], rows: [] },
] });
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
assert.deepEqual(wb.worksheets.map((w) => w.name), ['Rows 1 2', 'Rows 1 2 2'], 'illegal characters removed, duplicate names kept apart');
const ws = wb.worksheets[0];
assert.deepEqual(ws.getRow(1).values.slice(1), ['Invoice', 'Amount', 'Qty', 'Note']);
assert.equal(ws.getRow(2).getCell(2).value, 2398.5); assert.equal(typeof ws.getRow(2).getCell(2).value, 'number');
assert.equal(ws.getRow(2).getCell(2).numFmt, '#,##0.00', 'a column with paise shows two decimals');
assert.equal(ws.getRow(3).getCell(4).value, null, 'a missing cell stays empty');
assert.equal(ws.getRow(4).getCell(1).value, '=SUM(A1)', 'typed text is never turned into a formula');
assert.equal(ws.getRow(4).getCell(2).value, null, 'NaN becomes empty');
assert.equal(String(ws.getRow(4).getCell(4).value).length, 32000, 'a very long cell is cut to the Excel limit');
console.log('excel table: all checks passed');
