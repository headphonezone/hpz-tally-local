import ExcelJS from 'exceljs';

const COLUMNS = [
  { header: 'WCID', key: 'wcid', width: 14 },
  { header: 'Material Out No', key: 'moNumber', width: 18 },
  { header: 'Source', key: 'source', width: 9 },
  { header: 'Closure Date', key: 'sheetDate', width: 14 },
  { header: 'Customer', key: 'customer', width: 26 },
  { header: 'Party Ledger (from Material In)', key: 'party', width: 30 },
  { header: 'Stock Item (from Material In)', key: 'stockItem', width: 52 },
  { header: 'Qty', key: 'qty', width: 10 },
  { header: 'Godown', key: 'godown', width: 18 },
  { header: 'Narration', key: 'narration', width: 14 },
  { header: 'Material In Date', key: 'miDate', width: 16 },
  { header: 'Reason', key: 'reason', width: 46 },
  { header: 'Sheet Product (display only)', key: 'sheetProduct', width: 40 },
];

const flatten = (r) => ({
  wcid: r.wcid,
  moNumber: r.moNumber,
  source: r.source,
  sheetDate: r.sheetDate,
  customer: r.customer,
  party: r.mi?.party || r.sheetEmail || '',
  stockItem: r.mi?.stockItem || '',
  qty: r.mi?.qty || '',
  godown: r.mi?.godown || '',
  narration: r.mi?.narration || '',
  miDate: r.mi?.date || '',
  reason: r.reason,
  sheetProduct: r.sheetProduct,
});

function addSheet(wb, name, rows, colour) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
  rows.forEach((r) => ws.addRow(flatten(r)));
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  return ws;
}

export async function reportToXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HPZ Material Out app';
  wb.created = new Date();

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 62 }];
  const meta = [
    ['Generated', new Date(report.builtAt).toLocaleString()],
    ['Tally company', report.company || '(unknown)'],
    ['Workbook', report.book],
    ['Dispatch range', report.range ? `${report.range.from} to ${report.range.to}` : 'all'],
    ['Material In searched from', report.range?.materialInFrom || 'all'],
    ['', ''],
    ['Ready to create', report.counts.ready],
    ['Already created', report.counts.done],
    ['Blocked', report.counts.blocked],
    ['', ''],
    ['Sheet rows', report.totals.sheetRows],
    ['Material In vouchers', report.totals.materialIn],
    ['Material Out vouchers', report.totals.materialOut],
  ];
  meta.forEach(([k, v]) => summary.addRow([k, v]));
  summary.getColumn(1).font = { bold: true };

  const by = (s) => report.rows.filter((r) => r.status === s);
  addSheet(wb, 'Ready', by('ready'), 'FFD8EFD8');
  addSheet(wb, 'Blocked', by('blocked'), 'FFF6D9D9');
  addSheet(wb, 'Already created', by('done'), 'FFE6E6E6');

  return wb.xlsx.writeBuffer();
}
