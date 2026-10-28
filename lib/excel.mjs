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

// --- Credit Note (Goods Return): what the tab's Fetch found, one sheet per status ----------------------

const CN_STATUS = { ready: 'Ready to create', intally: 'Already in Tally', blocked: 'Blocked', error: 'Error', done: 'Created', failed: 'Failed', posting: 'Posting' };
const MONEY = '#,##0.00';
const tallyDate = (d) => String(d || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
const itemText = (l) => `${l.item}${Number(l.qty) > 1 ? ` × ${l.qty}` : ''}`;

const CN_COLUMNS = [
  { header: 'Order No', key: 'order', width: 12 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Credit Note No', key: 'cnNo', width: 15 },
  { header: 'Credit Note Date', key: 'cnDate', width: 15 },
  { header: 'Customer', key: 'customer', width: 24 },
  { header: 'Party Ledger', key: 'party', width: 30 },
  { header: 'Invoice No', key: 'invoice', width: 19 },
  { header: 'Invoice Date', key: 'invoiceDate', width: 13 },
  { header: 'Received', key: 'received', width: 12 },
  { header: 'RMA', key: 'rma', width: 17 },
  { header: 'Items', key: 'items', width: 56 },
  { header: 'Qty', key: 'qty', width: 6 },
  { header: 'Taxable', key: 'taxable', width: 12, style: { numFmt: MONEY } },
  { header: 'GST', key: 'gst', width: 11, style: { numFmt: MONEY } },
  { header: 'COD', key: 'cod', width: 9, style: { numFmt: MONEY } },
  { header: 'Amount', key: 'amount', width: 12, style: { numFmt: MONEY } },
  { header: 'Place of Supply', key: 'pos', width: 16 },
  { header: 'Already in Tally', key: 'existing', width: 44 },
  { header: 'Reason / Result', key: 'reason', width: 70 },
  { header: 'Warnings', key: 'warnings', width: 40 },
];

const CN_ITEM_COLUMNS = [
  { header: 'Order No', key: 'order', width: 12 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Credit Note No', key: 'cnNo', width: 15 },
  { header: 'RMA', key: 'rma', width: 17 },
  { header: 'Stock Item', key: 'item', width: 56 },
  { header: 'SKU', key: 'sku', width: 26 },
  { header: 'Qty', key: 'qty', width: 6 },
  { header: 'Rate', key: 'rate', width: 12, style: { numFmt: MONEY } },
  { header: 'Taxable', key: 'taxable', width: 12, style: { numFmt: MONEY } },
  { header: 'GST %', key: 'slab', width: 7 },
  { header: 'CGST', key: 'cgst', width: 10, style: { numFmt: MONEY } },
  { header: 'SGST', key: 'sgst', width: 10, style: { numFmt: MONEY } },
  { header: 'IGST', key: 'igst', width: 10, style: { numFmt: MONEY } },
  { header: 'COD', key: 'cod', width: 9, style: { numFmt: MONEY } },
  { header: 'Sales Ledger', key: 'ledger', width: 22 },
  { header: 'Godown', key: 'godown', width: 18 },
];

// Same wording as the Reason column on screen.
function cnReasonText(r) {
  switch (r.status) {
    case 'done': return r.created?.rmsText || '';
    case 'failed': return r.failure || '';
    case 'error': return r.error || '';
    default: return (r.problems || []).join(' · ');
  }
}

function cnFlatten(r) {
  const n = r.note;
  const lines = n?.lines || (r.rows || []).filter((x) => (r.selected || []).includes(x.rma_number));
  // The number a ready note will get, or the one it was created under; a blocked row has none yet.
  const numbered = n && ['ready', 'posting', 'done', 'failed'].includes(r.status);
  return {
    order: r.order_no,
    status: CN_STATUS[r.status] || r.status,
    cnNo: r.created?.voucherNumber || (numbered ? r.voucher_number : ''),
    cnDate: numbered ? r.voucher_date || '' : '',
    customer: r.customer_name || n?.customer_name || '',
    party: n?.party_ledger || r.customer_email || '',
    invoice: n?.invoice_no || r.invoice_no || '',
    invoiceDate: n?.invoice_date || '',
    received: r.first_received_date || '',
    rma: (r.selected || []).join(', '),
    items: lines.map(itemText).join('; '),
    qty: lines.reduce((s, l) => s + (Number(l.qty) || 0), 0) || null,
    taxable: n ? n.items_total : null,
    gst: n ? n.tax.reduce((s, t) => s + t.amount, 0) : null,
    cod: n ? n.cod : null,
    amount: n ? n.party_amount : null,
    pos: n?.place_of_supply || '',
    existing: (r.existing || []).map((e) => `${e.voucherNumber} (${tallyDate(e.date)}): ${e.items.map(itemText).join('; ')}`).join(' | '),
    reason: cnReasonText(r),
    warnings: (r.warnings || []).join(' · '),
  };
}

function cnSheet(wb, name, columns, rows, colour) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
  rows.forEach((r) => ws.addRow(r));
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };
  return ws;
}

export async function creditNoteReportToXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HPZ Material Out app — Credit Note';
  wb.created = new Date();
  const c = report.counts || {};

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 62 }];
  const meta = [
    ['Fetched', new Date(report.builtAt).toLocaleString('en-GB')],
    ['Tally company', report.company || '(unknown)'],
    ['Received', `${report.from} to ${report.to}`],
    ['', ''],
    ['Orders', c.all ?? report.rows.length],
    ['Ready to create', c.ready ?? 0],
    ['Already in Tally', c.intally ?? 0],
    ['Blocked', (c.blocked ?? 0) + (c.error ?? 0) + (c.failed ?? 0)],
    ['Created', c.done ?? 0],
    ['', ''],
    ['Ready amount', report.totals?.readyAmount ?? 0],
  ];
  if (report.truncated) meta.push(['Note', 'RMS returned more orders than one Fetch takes — narrow the dates']);
  meta.forEach(([k, v]) => summary.addRow([k, v]));
  summary.getColumn(1).font = { bold: true };
  summary.getCell(`B${meta.findIndex(([k]) => k === 'Ready amount') + 1}`).numFmt = MONEY;

  // The same groups as the cards on screen (Blocked includes errors and failed posts).
  const by = (...s) => report.rows.filter((r) => s.includes(r.status));
  cnSheet(wb, 'Ready', CN_COLUMNS, by('ready', 'posting').map(cnFlatten), 'FFD8EFD8');
  cnSheet(wb, 'Blocked', CN_COLUMNS, by('blocked', 'error', 'failed').map(cnFlatten), 'FFF6D9D9');
  cnSheet(wb, 'Already in Tally', CN_COLUMNS, by('intally').map(cnFlatten), 'FFE0E7FF');
  cnSheet(wb, 'Created', CN_COLUMNS, by('done').map(cnFlatten), 'FFE6E6E6');

  // One row per credit-note line, for every order whose note was worked out (ready, created, failed).
  const itemRows = by('ready', 'posting', 'done', 'failed').filter((r) => r.note).flatMap((r) => r.note.lines.map((l) => ({
    order: r.order_no, status: CN_STATUS[r.status] || r.status, cnNo: r.created?.voucherNumber || r.voucher_number,
    rma: l.rma_number, item: l.item, sku: l.sku, qty: l.qty, rate: l.rate, taxable: l.amount, slab: `${l.slab}%`,
    cgst: l.cgst, sgst: l.sgst, igst: l.igst, cod: l.cod, ledger: l.ledger, godown: l.godown,
  })));
  cnSheet(wb, 'Items', CN_ITEM_COLUMNS, itemRows, 'FFFEF3C7');

  return wb.xlsx.writeBuffer();
}

// --- E-Way Bill / E-Invoice tabs: the fetched list, as on screen ------------------------------------
const GST_STATUS = { open: 'Open', overdue: 'Overdue', closed: 'Closed', returned: 'Returned', cancelled: 'Cancelled on portal', missing: 'Missing' };
const PORTAL_STATE = {
  dispatched: 'Closed', cleared: 'BlueDart dispatched', awaiting: 'Awaiting BlueDart', manual: 'Close manually',
  no_awb: 'No AWB in Tally', not_in_manifest: 'Not in manifest', awb_unchecked: 'AWB not checked',
  cancelled: 'Cancelled on portal', not_in_tally: 'Not in Tally',
};
const ist = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');

export async function gstReportToXlsx(report) {
  const isEwb = report.kind === 'ewb';
  const label = isEwb ? 'e-Way Bill' : 'e-Invoice';
  const wb = new ExcelJS.Workbook();
  wb.creator = `HPZ Tally app — ${label}`;
  wb.created = new Date();
  const c = report.counts, m = report.missingCounts;

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 62 }];
  [
    ['Fetched', new Date(report.builtAt).toLocaleString('en-GB')],
    ['Tally company', report.company || '(unknown)'],
    ['Invoice dates', `${report.from} to ${report.to}`],
    ['', ''],
    [`${label}s`, c.all], ['Open', c.open], ['Overdue', c.overdue], ['Closed', c.closed], ['Cancelled', c.cancelled], ['Returned', c.returned],
    ...(isEwb ? [['On portal, not in Tally', c.notintally]] : []),
    ['', ''],
    [`Missing ${label}`, m.missing], ['Missing — closed', m.closed],
  ].forEach((r) => summary.addRow(r));
  summary.getColumn(1).font = { bold: true };

  const docCols = [
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Cancelled', key: 'cancel_note', width: 40 },
    { header: 'Invoice date', key: 'voucher_date', width: 12 },
    { header: 'Voucher', key: 'voucher_number', width: 20 },
    { header: isEwb ? 'EWB No' : 'Ack No', key: 'ref', width: 18 },
    { header: 'Party', key: 'party', width: 30 },
    { header: 'Value', key: 'value', width: 13, style: { numFmt: MONEY } },
    { header: 'AWB', key: 'awb', width: 16 },
    { header: 'Close by (IST)', key: 'deadline', width: 20 },
    { header: 'Clock started from', key: 'est', width: 18 },
    ...(isEwb ? [{ header: 'Portal check', key: 'portal', width: 20 }, { header: 'Portal note', key: 'portal_note', width: 40 }] : []),
    { header: 'Closed by', key: 'closed_by', width: 16 },
    { header: 'Closed at (IST)', key: 'closed_at', width: 20 },
    { header: 'Close reason', key: 'close_note', width: 44 },
    { header: isEwb ? 'EWB No (full)' : 'IRN (full)', key: 'doc_no', width: 30 },
  ];
  const docRow = (r) => ({
    ...r, status: GST_STATUS[r.status] || r.status, deadline: ist(r.deadline),
    est: { tally: 'Tally ack time', portal: 'Portal time', posted: 'Posted in Tally', invoice: 'Invoice date (est.)' }[r.deadline_basis] || (r.deadline_estimated ? 'Invoice date (est.)' : ''),
    portal: r.portal ? PORTAL_STATE[r.portal.state] || r.portal.state || 'On portal' : isEwb ? 'Not checked' : '',
    portal_note: r.portal?.note || '', closed_at: ist(r.closed_at),
  });
  cnSheet(wb, `${label}s`, docCols, report.docs.map(docRow), 'FFE0E7FF');

  const missCols = [
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Invoice date', key: 'voucher_date', width: 12 },
    { header: 'Voucher', key: 'voucher_number', width: 20 },
    { header: 'Party', key: 'party', width: 30 },
    { header: isEwb ? 'Place of supply' : 'GSTIN', key: isEwb ? 'place_of_supply' : 'gstin', width: 18 },
    { header: 'Value', key: 'value', width: 13, style: { numFmt: MONEY } },
    { header: 'Days open', key: 'days_open', width: 10 },
    { header: 'Reason', key: 'reason', width: 56 },
    { header: 'Closed by', key: 'closed_by', width: 16 },
    { header: 'Closed at (IST)', key: 'closed_at', width: 20 },
    { header: 'Close reason', key: 'close_note', width: 44 },
  ];
  cnSheet(wb, `Missing ${label}`, missCols,
    report.missing.map((r) => ({ ...r, status: GST_STATUS[r.status] || r.status, closed_at: ist(r.closed_at) })), 'FFF6D9D9');

  return wb.xlsx.writeBuffer();
}

// --- Missing Invoice tab (Gap Ledger) — the same columns as the Gap Ledger's own download ----------
const MI_STATUS = { missing: 'Missing', tally: 'Cancelled', uc: 'Cancelled' };

export async function missingInvoiceToXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HPZ Tally app — Missing Invoice';
  wb.created = new Date();
  const c = report.counts;

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 62 }];
  [
    ['Fetched', new Date(report.builtAt).toLocaleString('en-GB')],
    ['Tally company', report.company || '(unknown)'],
    ['Dates', `${report.from} to ${report.to}`],
    ['Voucher type', report.type],
    ['Series', report.series === '*' ? 'All series' : report.series],
    ['Vouchers scanned', report.scanned],
    ['', ''],
    ['Truly missing', c.missing], ['Cancelled in Tally', c.tally], ['Cancelled in Unicommerce', c.uc],
    ...(report.ucNote ? [['', ''], ['Note', report.ucNote]] : []),
  ].forEach((r) => summary.addRow(r));
  summary.getColumn(1).font = { bold: true };

  cnSheet(wb, 'Missing Vouchers', [
    { header: 'Series', key: 'series', width: 16 },
    { header: 'Month', key: 'month', width: 10 },
    { header: 'Voucher No.', key: 'id', width: 22 },
    { header: 'Status', key: 'status', width: 11 },
    { header: 'Cancelled In', key: 'cancelledIn', width: 22 },
    { header: 'Order No.', key: 'orderNo', width: 14 },
    { header: 'Unicommerce Status', key: 'ucStatus', width: 34 },
  ], report.rows.map((r) => ({ ...r, status: MI_STATUS[r.status] || r.status })), 'FFF6D9D9');

  cnSheet(wb, 'Series', [
    { header: 'Prefix', key: 'prefix', width: 18 },
    { header: 'From', key: 'min', width: 10 }, { header: 'To', key: 'max', width: 10 },
    { header: 'Found', key: 'count', width: 10 }, { header: 'Expected', key: 'expected', width: 10 },
    { header: 'Missing', key: 'missing', width: 10 }, { header: 'Cancelled', key: 'cancelled', width: 10 },
    { header: 'Note', key: 'note', width: 40 },
    { header: 'Not counted — outside these dates', key: 'blocksText', width: 50 },
    { header: 'Also written as', key: 'alsoText', width: 24 },
  ], report.groups.map((g) => ({ ...g, note: g.tooSmall ? 'too few numbers to check' : g.tooLarge ? 'range too large — not checked'
    : g.sparse ? 'older series — gaps not counted' : '',
    blocksText: (g.blocks || []).map((b) => `${b.from}–${b.to} (${b.size})`).join(', '),
    alsoText: (g.also || []).join(', ') })), 'FFE0E7FF');

  return wb.xlsx.writeBuffer();
}
