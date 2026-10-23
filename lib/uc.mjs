// Unicommerce client: auth, the "Tally GST Report 3.0" export job, and grouping its rows into orders.
//
// Verified live against hpz.unicommerce.com (2026-10-15): token is fetched with GET (not POST — this
// tenant's proxy only allows GET on /oauth/token), export/job/create needs a Facility header or it is
// refused with "Illegal Access, facility is required", and the status poll returns status "COMPLETE"
// (not "SUCCESSFUL" as the public docs say) with a CloudFront filePath once the CSV is ready.

const BASE = (process.env.UNICOMMERCE_BASE_URL || '').replace(/\/+$/, '');
const TOKEN_URL = process.env.UNICOMMERCE_TOKEN_URL || `${BASE}/oauth/token`;
const ORDER_URL = process.env.UNICOMMERCE_ORDER_URL || `${BASE}/oms/saleorder/get`;
const CLIENT_ID = process.env.UNICOMMERCE_CLIENT_ID || 'my-trusted-client';
const USERNAME = process.env.UNICOMMERCE_USERNAME || '';
const PASSWORD = process.env.UNICOMMERCE_PASSWORD || '';
const FACILITY = process.env.UNICOMMERCE_FACILITY || '';
const REPORT_NAME = 'Tally GST Report 3.0';

export const configured = () => Boolean(BASE && USERNAME && PASSWORD && FACILITY);

// Columns captured from the real UI export request (DevTools, 2026-10-15) — the full 80-column set.
const EXPORT_COLUMNS = ['invoiceDate', 'saleOrderCode', 'invoiceCode', 'channelName', 'channelLedgerName', 'productCode', 'productSKU', 'QTY', 'unitPrice', 'Currency', 'currencyConversionRate', 'total', 'customerName', 'shippingAddressName', 'shippingAddressLine1', 'shippingAddressLine2', 'shippingAddressCity', 'shippingAddressState', 'shippingAddressCountry', 'shippingAddressPincode', 'shippingAddressPhone', 'shippingProvider', 'trackingNumber', 'sales', 'salesLedger', 'cgst', 'cgstRate', 'sgst', 'sgstRate', 'igst', 'igstRate', 'utgst', 'utgstRate', 'cess', 'cessRate', 'OtherCharges', 'OtherChargesLedger', 'OtherCharges1', 'OtherChargesLedger1', 'Servicetax', 'ServicetaxLedger', 'discountLedger', 'discountAmount', 'imei', 'godDown', 'dispatchdate', 'narration', 'entity', 'voucherTypeName', 'tin', 'original', 'original1', 'channelInvoiceDate', 'channelState', 'customerGSTIN', 'channelPartyGSTIN', 'billingPartyCode', 'taxVerification', 'gstregistrationtype', 'TCSAmount', 'ajustmentInSellingPrice', 'ajustmentInDiscount', 'OtherChargesLedger2', 'OtherCharges2', 'storeCredit', 'prepaidAmount', 'taxOnOtherCharges', 'taxOnOtherCharges1', 'taxOnOtherCharges2', 'irn', 'acknowledgementNumber', 'hsnCode', 'paymentMethod', 'billingAddressLine1', 'billingAddressLine2', 'isbn', 'bundleSkuCode', 'shippingGstin', 'billingGstin', 'paemail', 'stste1', 'city1', 'phone1', 'pincode1', 'email1'];

let cachedToken = null; // { token, expiresAt }

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.token;
  const u = new URL(TOKEN_URL);
  u.searchParams.set('grant_type', 'password');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('username', USERNAME);
  u.searchParams.set('password', PASSWORD);
  const res = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Unicommerce token HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Unicommerce token response had no access_token');
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000 };
  return cachedToken.token;
}

async function authed(path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Facility: FACILITY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.successful === false) {
    const msg = data.errors?.map((e) => e.description || e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Unicommerce: ${msg}`);
  }
  return data;
}

// date is a YYYY-MM-DD string, taken as a full IST calendar day (00:00:00.000 to 23:59:59.999 IST).
function istDayRangeMs(fromYmd, toYmd) {
  const start = new Date(`${fromYmd}T00:00:00+05:30`).getTime();
  const end = new Date(`${toYmd}T23:59:59.999+05:30`).getTime();
  return { start, end };
}

async function createExportJob(fromYmd, toYmd) {
  const { start, end } = istDayRangeMs(fromYmd, toYmd);
  const data = await authed('/services/rest/v1/export/job/create', {
    exportJobTypeName: REPORT_NAME,
    exportColums: EXPORT_COLUMNS,
    exportFilters: [
      { id: 'addedOn', dateRange: { start, end } },
      { id: 'dateRange', dateRange: { start, end } },
    ],
    frequency: 'ONETIME',
  });
  return data.jobCode;
}

async function pollExportJob(jobCode, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await authed('/services/rest/v1/export/job/status', { jobCode });
    if (data.status === 'COMPLETE' && data.filePath) return data.filePath;
    if (data.status && /FAIL|ERROR/i.test(data.status)) throw new Error(`Unicommerce export job failed: ${data.status}`);
    if (Date.now() > deadline) throw new Error(`Unicommerce export job timed out (last status: ${data.status})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function downloadCsv(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`report download HTTP ${res.status}`);
  return res.text();
}

// Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines, "" escaping). No dependency —
// the export is machine-generated, not hand-edited, so this covers it without pulling in a CSV library.
// onRow(obj): each data row is handed over as it is read and not kept — the 1-23 Oct 2026 report was
// 25,167 rows x 85 columns, ~266 MB held at once, which took the app past pm2's 400 MB restart limit.
// Without onRow, every row is returned (as before).
export function parseCsv(text, onRow) {
  const rows = [];
  let header = null, row = [];
  const pushRow = () => {
    if (!header) header = row;
    else if (row.length > 1 || row[0] !== '') {
      const obj = Object.fromEntries(header.map((h, idx) => [h, row[idx] ?? '']));
      if (onRow) onRow(obj); else rows.push(obj);
    }
    row = [];
  };
  // Each value is cut out of the text in one piece. (Built a character at a time, the 21 MB report of
  // 1-23 Oct 2026 took ~10x its size in string fragments.) Same rules as before: "" inside quotes is a
  // quote, a CR outside quotes is dropped, a LF ends the row.
  const n = text.length;
  let i = 0;
  while (i < n) {
    let val = '';
    for (;;) {   // one field, possibly in pieces: plain runs and quoted runs
      if (text[i] === '"') {
        let j = i + 1;
        for (;;) {
          const qi = text.indexOf('"', j);
          if (qi === -1) { val += text.slice(j); i = n; break; }
          if (text[qi + 1] === '"') { val += text.slice(j, qi + 1); j = qi + 2; continue; }
          val += text.slice(j, qi); i = qi + 1; break;
        }
        continue;
      }
      let j = i;
      while (j < n) { const c = text.charCodeAt(j); if (c === 44 || c === 10 || c === 13 || c === 34) break; j++; }
      val += text.slice(i, j); i = j;
      if (i < n && text.charCodeAt(i) === 13) { i++; continue; }   // CR outside quotes: dropped
      if (i < n && text.charCodeAt(i) === 34) continue;             // a quote mid-field opens a quoted run
      break;
    }
    row.push(val);
    if (i >= n) break;
    if (text.charCodeAt(i) === 44) { i++; if (i >= n) row.push(''); continue; }   // comma
    i++;   // LF
    pushRow();
  }
  if (row.length) pushRow();
  return rows;
}

const num = (s) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

// Group CSV rows (one per item line) into orders keyed by Invoice number — the key Tally already uses
// as its voucher number for these (confirmed against 518 real Oct-10 vouchers: 1:1, no exceptions).
// Address as up to 3 separate lines — Line 1 alone, Line 2 + City together, State + Pincode together
// — matching how addresses are actually written in this company's real Tally data (a human-entered
// example: "B-1, Mansi Appartment, Near Maninagar" / "Railway Station, Maninagar, Ahmedabad," /
// "Gujarat, 380008"). Falls back entirely to the OTHER address (Billing <-> Shipping) only when every
// one of this prefix's fields is blank — many orders only ever collect a shipping address.
const addressLines = (r, prefix) => {
  const other = prefix === 'Billing' ? 'Shipping' : 'Billing';
  const pick = (p, key) => r[`${p} Address ${key}`] || '';
  let [line1, line2, city, state, pincode] = ['Line 1', 'Line 2', 'City', 'State', 'Pincode'].map((k) => pick(prefix, k));
  if (![line1, line2, city, state, pincode].some(Boolean)) {
    [line1, line2, city, state, pincode] = ['Line 1', 'Line 2', 'City', 'State', 'Pincode'].map((k) => pick(other, k));
  }
  const lines = [];
  if (line1) lines.push(line1);
  const line2City = [line2, city].filter(Boolean).join(', ');
  if (line2City) lines.push(line2City);
  const stateline = [state, pincode].filter(Boolean).join(', ');
  if (stateline) lines.push(stateline);
  return lines; // array of up to 3 lines, not a single joined string
};

// The columns an item line is read for (ucsales.computeSalesOrder and the screen). Order-level fields
// come from the order's first row below; an item row keeps only these, not all 85 report columns.
const LINE_COLUMNS = ['Product Name', 'Qty', 'Unit Price', 'Sales', 'Sales Ledger', 'HSN Code', 'Total',
  'CGST', 'CGST Rate', 'SGST', 'SGST Rate', 'IGST', 'IGST Rate', 'UTGST', 'UTGST Rate', 'CESS', 'CESS Rate',
  'Other charges', 'Other charges Ledger', 'Other charges1', 'Other charges Ledger1', 'Other charges2', 'Other charges Ledger2',
  'Service tax', 'ST Ledger'];
const lineOf = (r) => Object.fromEntries(LINE_COLUMNS.filter((c) => r[c] !== undefined && r[c] !== '').map((c) => [c, r[c]]));

export function groupOrders(rowsRaw) {
  const byInvoice = new Map();
  for (const r of rowsRaw) addRow(byInvoice, r);
  return [...byInvoice.values()];
}

function addRow(byInvoice, r) {
  const inv = r['Invoice number'];
  if (!inv) return;
  if (!byInvoice.has(inv)) {
    byInvoice.set(inv, {
      invoice: inv,
      saleOrderNumber: r['Sale Order Number'],
      date: r['Date'],
      customerEmail: r['Customer Email'] || r['Billing Address Email'] || '',
      customerName: r['Customer Name'] || '',
      customerMobile: r['Billing Address Phone'] || r['Shipping Address Phone'] || '',
      billingState: r['Billing Address State'] || r['Shipping Address State'] || '',
      billingAddress: addressLines(r, 'Billing'),
      billingPincode: r['Billing Address Pincode'] || r['Shipping Address Pincode'] || '',
      // Shipping (consignee) fields kept SEPARATE from billing — captured 2026-10-15 for the
      // Consignee block and Dispatch Details, which were not being filled at all before this.
      shippingState: r['Shipping Address State'] || '',
      shippingAddress: addressLines(r, 'Shipping'),
      shippingPincode: r['Shipping Address Pincode'] || '',
      awbNumber: r['AWB num'] || '',
      shippingProviderName: r['Shipping Provider'] || '',
      irn: r['IRN'] || '',
      irnAckNo: r['Acknowledgement Number'] || '',
      customerGSTIN: r['Customer GSTIN'] || '',
      gstRegistrationType: r['GST Registration Type'] || 'Unregistered/Consumer',
      paymentMethod: r['Payment Method'] || '',
      channel: r['Channel Ledger'] || '',
      rows: [],
    });
  }
  byInvoice.get(inv).rows.push(lineOf(r));
}

// The raw export as CSV text.
export async function fetchSalesCsv(fromYmd, toYmd) {
  if (!configured()) throw new Error('Unicommerce is not configured — set UNICOMMERCE_* in .env');
  const jobCode = await createExportJob(fromYmd, toYmd);
  return downloadCsv(await pollExportJob(jobCode));
}

export async function fetchSalesReport(fromYmd, toYmd) {
  const csv = await fetchSalesCsv(fromYmd, toYmd);
  const byInvoice = new Map();
  let rowCount = 0;
  parseCsv(csv, (r) => { rowCount++; addRow(byInvoice, r); });
  return { orders: [...byInvoice.values()], rowCount };
}

export { num };

// --- Invoice lookup (Missing Invoice tab) ----------------------------------------------------------
// Invoice number -> its shipping package and sale order, ported from Desktop\Missing Invoice\server.py
// (Gap Ledger). A cancelled package carries no invoice code in a status search, so it is found by
// Search Shipping Package on invoiceCode (facility level), then Get Sale Order (tenant level, no
// Facility header) for the order status and the channel order number.
async function ucPost(path, body, { facility = true, tries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` };
    if (facility) headers.Facility = FACILITY;
    let res;
    try {
      res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    } catch (err) {
      if (attempt < tries - 1) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      throw new Error(`Could not reach Unicommerce (${err.message})`);
    }
    // Unicommerce throttles a burst of parallel lookups (429) or drops them (5xx): back off and retry.
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < tries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue;
    }
    if (res.status === 401 && attempt === 0) { cachedToken = null; continue; }   // expired token: one fresh login
    if (!res.ok) throw new Error(`Unicommerce HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

export async function lookupInvoice(invoice) {
  const res = await ucPost('/services/rest/v1/oms/shippingPackage/search', { invoiceCode: invoice });
  const p = (res.elements || [])[0];
  if (!p) return { invoice, found: false };
  const out = { invoice, found: true, packageStatus: p.status || '', saleOrderCode: p.saleOrderCode || '',
    orderNo: p.saleOrderCode || '', orderStatus: '' };
  if (p.saleOrderCode) {
    const so = (await ucPost('/services/rest/v1/oms/saleorder/get', { code: p.saleOrderCode }, { facility: false })).saleOrderDTO || {};
    out.orderStatus = so.status || '';
    out.orderNo = so.displayOrderCode || out.orderNo;
  }
  return out;
}
