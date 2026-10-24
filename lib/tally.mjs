// TallyPrime gateway client (port 9000).
//
// Two transports, and the split is not a style choice:
//   - reads  : XML, because an ad-hoc collection needs embedded TDL and Tally
//              returns an empty body when TDL is embedded in a JSON request.
//   - writes : JSON, TallyRequest/Type/Id carried as HTTP HEADERS not body keys.
//
// Never send charset=utf-16 on a UTF-8 body: Tally answers a 118-byte stub
// with no error, which reads exactly like an empty company.

const TALLY_URL = process.env.HPZ_TALLY_URL || 'http://localhost:9000';

// The gateway ignores SVFROMDATE/SVTODATE on a Vouchers:VoucherType collection
// (a one-day request returns the whole year), but omitting them returns nothing.
// So they are period context, not a filter — date narrowing happens in JS.
const PERIOD = { from: '1-Apr-2000', to: '31-Mar-2100' };

// ONE request at a time, always.
//
// The gateway wedges when requests overlap: it climbs past 3 GB and stops
// responding, and the process then has to be killed. This was reproduced in a
// company holding thirteen vouchers, so it is concurrency that breaks it, not
// data volume. Every call goes through this queue — do not add a bare fetch,
// and do not wrap these functions in Promise.all.
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function post(body, headers = {}) {
  return serialize(async () => {
    const res = await fetch(TALLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', ...headers },
      body: encodeForTally(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`Tally HTTP ${res.status}`);
    return decodeTally(new Uint8Array(await res.arrayBuffer()));
  });
}

// Tally declares UTF-8 but sends some characters as a single raw byte — a no-break space inside a
// name comes as byte A0 (found 2026-10-21 in "FiiO<A0>- TRUST - LT-LT5M - 800mm - Type C to Lightning -
// Cable - Accessory" and its "Unboxed - " twin). Decoded as UTF-8 that byte became U+FFFD, the name
// no longer matched the Unicommerce product and the order was blocked as "stock item not found".
// So: real UTF-8 sequences decode as UTF-8, and any stray byte is read as Windows-1252 (A0 -> U+00A0).
// The name then matches on itemKey (which treats it as a space) and is posted in Tally's own spelling.
const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013,
  0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
export function decodeTally(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  try { return strictUtf8.decode(bytes); } catch { /* stray single bytes: decode by hand below */ }
  // Valid runs are decoded in one go and only a stray byte is handled on its own. (Building the text a
  // character at a time left hundreds of MB of garbage per 7 MB response — 2026-10-22.)
  const out = [];
  let start = 0;
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { i++; continue; }
    const len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let ok = len > 0 && i + len <= bytes.length;
    for (let k = 1; ok && k < len; k++) ok = (bytes[i + k] & 0xc0) === 0x80;
    if (ok && strictUtf8Ok(bytes.subarray(i, i + len))) { i += len; continue; }
    if (i > start) out.push(strictUtf8.decode(bytes.subarray(start, i)));
    out.push(String.fromCodePoint(CP1252[b] || b));
    start = ++i;
  }
  if (start < bytes.length) out.push(strictUtf8.decode(bytes.subarray(start)));
  return out.join('');
}
// A sequence that looks well-formed can still be invalid (overlong, surrogate, > U+10FFFF).
function strictUtf8Ok(seq) {
  try { strictUtf8.decode(seq); return true; } catch { return false; }
}

// What goes TO Tally. Tally reads the bytes of a request as Windows-1252, not UTF-8: a no-break space in a
// name (FiiO<A0>- TRUST - LT-LT5M ...) sent as UTF-8 (C2 A0) is NOT that stock item for Tally, which answered
// "Stock Item '...' does not exist!" and refused 27 Unicommerce invoices (2026-10-24). Read-only test with that
// very name: UTF-8 not found, Windows-1252 found. So every request is sent as Windows-1252 bytes when all of its
// characters exist there; if any does not (a rupee sign, an Indian script) it stays UTF-8, as before.
const CP1252_REV = new Map(Object.entries(CP1252).map(([b, cp]) => [cp, Number(b)]));
export function encodeForTally(str) {
  const out = Buffer.allocUnsafe(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else if (CP1252_REV.has(c)) out[i] = CP1252_REV.get(c);
    else return Buffer.from(str, 'utf8');
  }
  return out;
}

export async function ping() {
  try {
    return await serialize(async () => {
      const res = await fetch(TALLY_URL, { method: 'GET', signal: AbortSignal.timeout(5000) });
      return /Running/i.test(await res.text());
    });
  } catch {
    return false;
  }
}

function envelope({ id, type = 'Collection', staticVars = '', tdl = '' }) {
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>${type}</TYPE><ID>${id}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${staticVars}</STATICVARIABLES>
<TDL><TDLMESSAGE>${tdl}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

// The open company's CURRENT PERIOD (Alt+F2 in Tally), { from, to } as yyyymmdd, plus Tally's current
// date. Tally hides every voucher after the period's end from every request, typed dates or not: on
// 2026-10-22 a company reopened with the period ending 30-Sep returned nothing for October, the COD check
// saw no October journals or invoices, and a batch went out with journal numbers already in use.
//
// Company.EndingAt is the EARLIER of the period end and Tally's current date (F2). The current date hides
// nothing (2026-10-24: Tally's date 23-Oct, a journal dated 24-Oct read back fine). So when EndingAt is
// the current date, the period end is read from ##SVToDate; when it is before the current date, it IS
// the period end.
export async function companyPeriod() {
  const xml = await post(envelope({
    id: 'HPZCoPeriod',
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZIsCurP">$Name = ##SVCurrentCompany</SYSTEM>
<COLLECTION NAME="HPZCoPeriod" ISMODIFY="No"><TYPE>Company</TYPE><FILTER>HPZIsCurP</FILTER>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>StartingFrom</NATIVEMETHOD><NATIVEMETHOD>EndingAt</NATIVEMETHOD>
<COMPUTE>HPZSVTo : ##SVToDate</COMPUTE><COMPUTE>HPZSVCur : ##SVCurrentDate</COMPUTE></COLLECTION>`,
  }));
  const d8 = (tag) => (xml.match(new RegExp(`<${tag}[^>]*>(\\d{8})<`)) || [])[1] || null;
  const from = d8('STARTINGFROM'), endingAt = d8('ENDINGAT'), svTo = d8('HPZSVTO'), currentDate = d8('HPZSVCUR');
  if (!from && !endingAt) return null;
  const to = endingAt && currentDate && endingAt < currentDate ? endingAt : (svTo || endingAt);
  return { from, to, currentDate, endingAt };
}

// Requests deliberately omit SVCURRENTCOMPANY so every read and write lands on
// whichever company is open in Tally right now.
export async function activeCompany() {
  const xml = await post(envelope({
    id: 'HPZActiveCo',
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZIsCur">$Name = ##SVCurrentCompany</SYSTEM>
<COLLECTION NAME="HPZActiveCo" ISMODIFY="No"><TYPE>Company</TYPE><FILTER>HPZIsCur</FILTER>
<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  const m = xml.match(/<COMPANY[^>]*\sNAME="([^"]*)"/);
  return m ? decodeEntities(m[1]) : null;
}

export async function loadedCompanies() {
  const xml = await post(envelope({
    id: 'HPZCos',
    tdl: `<COLLECTION NAME="HPZCos" ISMODIFY="No"><TYPE>Company</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  return [...xml.matchAll(/<COMPANY[^>]*\sNAME="([^"]*)"/g)]
    .map((m) => decodeEntities(m[1]))
    .filter(Boolean);
}

// Godown names, for the Stock Journal From/To pickers — so a godown renamed in Tally shows up as
// missing before a posting is attempted, not as a failed import.
export async function listGodowns() {
  const xml = await post(envelope({
    id: 'HPZGodowns',
    tdl: `<COLLECTION NAME="HPZGodowns" ISMODIFY="No"><TYPE>Godown</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  return [...xml.matchAll(/<GODOWN[^>]*\sNAME="([^"]*)"/g)]
    .map((m) => decodeEntities(m[1]))
    .filter(Boolean);
}

// Every stock-item name (about 5,000). Names only, so it stays cheap. A Stock Journal line must
// name an item that exists exactly, or Tally would reject it — or worse, create a new item.
export async function listStockItemNames() {
  const xml = await post(envelope({
    id: 'HPZStockItems',
    tdl: `<COLLECTION NAME="HPZStockItems" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  return [...xml.matchAll(/<STOCKITEM[^>]*\sNAME="([^"]*)"/g)]
    .map((m) => decodeEntities(m[1]))
    .filter(Boolean);
}

// Every stock item with its base unit: Nos for almost all, a few Pcs/Prs. An item whose unit is
// "Not Applicable" keeps no quantity — a Stock Journal line for it lands in Tally with quantity 0
// (2026-10-24, backup company: "1MORE - Piston Fit - Grey - Type-C" posted as 0 out of Chennai).
export async function stockItemUnits() {
  const xml = await post(envelope({
    id: 'HPZItemUnits',
    tdl: `<COLLECTION NAME="HPZItemUnits" ISMODIFY="No"><TYPE>StockItem</TYPE>
<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>BaseUnits</NATIVEMETHOD></COLLECTION>`,
  }));
  const units = new Map();
  for (const b of sliceBlocks(xml.slice(Math.max(0, xml.indexOf('<DATA>'))), 'STOCKITEM')) {
    const name = decodeEntities((b.match(/<STOCKITEM[^>]*\sNAME="([^"]*)"/) || [])[1] || '');
    if (name) units.set(name, scalar(b, 'BASEUNITS'));
  }
  return units;
}

// Tally date literal, e.g. 20260504 -> "4-May-2026".
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function tallyDateLiteral(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${+s.slice(6, 8)}-${MONTH_NAMES[+s.slice(4, 6) - 1]}-${s.slice(0, 4)}`;
}

// Only the voucher numbers, over the whole company. This is what the duplicate
// guard and the "does this WCID exist at all" question need, and it stays cheap
// because no inventory or ledger tree is fetched.
export async function voucherNumbersOfType(voucherType) {
  const xml = await post(envelope({
    id: 'HPZVchNo',
    staticVars: `<SVFROMDATE>${PERIOD.from}</SVFROMDATE><SVTODATE>${PERIOD.to}</SVTODATE>`,
    tdl: `<COLLECTION NAME="HPZVchNo" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE>
<CHILDOF>${voucherType}</CHILDOF><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD></COLLECTION>`,
  }));
  return [...xml.matchAll(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/g)].map((m) => decodeEntities(m[1]));
}

// Voucher numbers of one type within a date range, using TYPED dates (TYPE="Date") — proven live
// (2026-10-15) to actually narrow a Vouchers:VoucherType collection, unlike the untyped PERIOD form
// voucherNumbersOfType() above uses. Use THIS, not that one, for a voucher type that can hold a large
// volume (Sales did: 8,343 vouchers in just 14 days of one company). The untyped all-time walk timed
// out and put Tally at 5+ GB when tried against Sales; the typed range form returns ~500 numbers for
// one day in under a second.
export async function voucherNumbersOfTypeInRange(voucherType, fromYmd, toYmd) {
  const xml = await post(envelope({
    id: 'HPZVchNoRange',
    staticVars: `<SVFROMDATE TYPE="Date">${tallyDateLiteral(fromYmd)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDateLiteral(toYmd)}</SVTODATE>`,
    tdl: `<COLLECTION NAME="HPZVchNoRange" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE>
<CHILDOF>${q(voucherType)}</CHILDOF><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD></COLLECTION>`,
  }));
  return [...xml.matchAll(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/g)].map((m) => decodeEntities(m[1]));
}

// Every Sales-class voucher of ONE day (Sales, Amazon Sales, UniCommerce Sales… via BELONGSTO) with
// its GST documents — IRN and e-Way Bills — plus the fields the missing-document rules need. Typed
// dates keep it to that day: ~1,050 vouchers in 1.6 s (2026-10-17). The $Date filter is a safety net,
// so if the period were ever ignored the request is slow but still returns one day, never the year.
// Field names read off live vouchers HPZPL2627-184284 (EWB) and -184807 (IRN), 2026-10-17.
export async function salesGstForDay(yyyymmdd) {
  const d = tallyDateLiteral(yyyymmdd);
  const xml = await post(envelope({
    id: 'HPZGstDay',
    staticVars: `<SVFROMDATE TYPE="Date">${d}</SVFROMDATE><SVTODATE TYPE="Date">${d}</SVTODATE>`,
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZGstOnDay">$Date = $$Date:"${d}"</SYSTEM>
<COLLECTION NAME="HPZGstDay" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Sales')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZGstOnDay</FILTER><FETCH>VoucherNumber,Date,VoucherTypeName,GUID,MasterId,IsCancelled,PartyLedgerName,PartyGSTIN,GSTRegistrationType,PlaceOfSupply,Reference,BasicShipDocumentNo,BasicShippedBy,Amount,IRN,IRNAckNo,IRNAckDate,IRNAckUpdateDateTime,IRNCancelled,EWayBillDetails.BillNumber,EWayBillDetails.BillDate,EWayBillDetails.UpdatedDate,EWayBillDetails.IsCancelled,EWayBillDetails.CancelDate</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  const yes = (s) => s.toLowerCase() === 'yes';
  return sliceBlocks(data, 'VOUCHER').map((v) => {
    // Read voucher-level fields with every nested list removed first: an e-Way Bill carries its own
    // ISCANCELLED, and an inventory line its own AMOUNT, which would otherwise be read instead.
    const head = v.replace(/<([A-Z0-9]+(?:\.[A-Z0-9]+)*\.LIST)>[\s\S]*?<\/\1>/g, '');
    // `no` is the bare 12 digits (as the GSP sends it); `raw` is Tally's own spelling, sometimes
    // "5720 8926 4827" — the form the nightly sync stored in gst_documents / gst_dispatch_log.
    const ewbs = sliceBlocks(v, 'EWAYBILLDETAILS.LIST').map((e) => ({
      no: scalar(e, 'BILLNUMBER').replace(/\s+/g, ''),
      raw: scalar(e, 'BILLNUMBER'),
      date: tallyStamp(scalar(e, 'BILLDATE'))?.slice(0, 10) || null,
      updatedAt: tallyStamp(scalar(e, 'UPDATEDDATE')),
      // Read from the raw collection, where the flag IS present (AUDIT.md #2: the report path always
      // said "No"). Verified on 562015016723 / HPZPL2627-48064, cancelled 3-Jun-2026 and replaced.
      cancelled: yes(scalar(e, 'ISCANCELLED')) || Boolean(tallyStamp(scalar(e, 'CANCELDATE'))),
      cancelDate: tallyStamp(scalar(e, 'CANCELDATE'))?.slice(0, 10) || null,
    })).filter((e) => e.no);
    return {
      voucherNumber: scalar(head, 'VOUCHERNUMBER'),
      date: tallyStamp(scalar(head, 'DATE'))?.slice(0, 10) || null,
      voucherType: scalar(head, 'VOUCHERTYPENAME'),
      guid: scalar(head, 'GUID'),
      masterId: scalar(head, 'MASTERID'),
      cancelled: yes(scalar(head, 'ISCANCELLED')),
      party: scalar(head, 'PARTYLEDGERNAME'),
      gstin: scalar(head, 'PARTYGSTIN'),
      regType: scalar(head, 'GSTREGISTRATIONTYPE'),
      placeOfSupply: scalar(head, 'PLACEOFSUPPLY'),
      reference: scalar(head, 'REFERENCE'),
      awb: scalar(head, 'BASICSHIPDOCUMENTNO'),
      shippedBy: scalar(head, 'BASICSHIPPEDBY'),
      value: Math.abs(Number(scalar(head, 'AMOUNT')) || 0),
      irn: scalar(head, 'IRN'),
      irnAckNo: scalar(head, 'IRNACKNO'),
      irnAckAt: tallyStamp(scalar(head, 'IRNACKUPDATEDATETIME')),
      irnCancelled: yes(scalar(head, 'IRNCANCELLED')),
      ewbs,
    };
  });
}

// Number, date, type and cancel flag of every Sales-class voucher (Sales, Amazon Sales, UniCommerce
// Sales… via BELONGSTO) between two dates — what the Missing Invoice tab checks for gaps. Typed dates
// narrow it; the $Date filter keeps it to the range even if the period were ever ignored. Measured
// 2026-10-20: 16,721 vouchers (1–20 Oct) in 9.8 s, so the caller asks one month at a time.
export async function salesNumbersInRange(fromYmd, toYmd) {
  const f = tallyDateLiteral(fromYmd), t = tallyDateLiteral(toYmd);
  const xml = await post(envelope({
    id: 'HPZGapNos',
    staticVars: `<SVFROMDATE TYPE="Date">${f}</SVFROMDATE><SVTODATE TYPE="Date">${t}</SVTODATE>`,
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZGapIn">$Date &gt;= $$Date:"${f}" AND $Date &lt;= $$Date:"${t}"</SYSTEM>
<COLLECTION NAME="HPZGapNos" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Sales')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZGapIn</FILTER><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>Date</NATIVEMETHOD>
<NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  return sliceBlocks(data, 'VOUCHER').map((v) => ({
    no: scalar(v, 'VOUCHERNUMBER'),
    date: scalar(v, 'DATE'),   // yyyymmdd
    type: scalar(v, 'VOUCHERTYPENAME') || '(unknown)',
    cancelled: scalar(v, 'ISCANCELLED').toLowerCase() === 'yes',
  }));
}

// The shipped Sales-class invoices of ONE day — AWB, party, order number (Reference), value — for the
// COD Import tab. Leaner than salesGstForDay (no e-Way Bill / IRN lists): that read is ~7 MB of XML a
// day, and parsing 26 days of it took this app past pm2's 400 MB restart limit (2026-10-22).
export async function salesShipmentsForDay(yyyymmdd) {
  const d = tallyDateLiteral(yyyymmdd);
  const xml = await post(envelope({
    id: 'HPZShipDay',
    staticVars: `<SVFROMDATE TYPE="Date">${d}</SVFROMDATE><SVTODATE TYPE="Date">${d}</SVTODATE>`,
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZShipOnDay">$Date = $$Date:"${d}"</SYSTEM>
<COLLECTION NAME="HPZShipDay" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Sales')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZShipOnDay</FILTER><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
<NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD><NATIVEMETHOD>Reference</NATIVEMETHOD>
<NATIVEMETHOD>BasicShipDocumentNo</NATIVEMETHOD><NATIVEMETHOD>BasicShippedBy</NATIVEMETHOD><NATIVEMETHOD>Amount</NATIVEMETHOD></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  const out = [];
  for (const v of sliceBlocks(data, 'VOUCHER')) {
    const awb = scalar(v, 'BASICSHIPDOCUMENTNO');
    if (!awb) continue;
    out.push({
      voucherNumber: scalar(v, 'VOUCHERNUMBER'),
      date: tallyStamp(scalar(v, 'DATE'))?.slice(0, 10) || null,
      voucherType: scalar(v, 'VOUCHERTYPENAME'),
      cancelled: scalar(v, 'ISCANCELLED').toLowerCase() === 'yes',
      party: scalar(v, 'PARTYLEDGERNAME'),
      reference: scalar(v, 'REFERENCE'),
      awb,
      shippedBy: scalar(v, 'BASICSHIPPEDBY'),
      value: Math.abs(Number(scalar(v, 'AMOUNT')) || 0),
    });
  }
  return out;
}

// Which of these ledgers keep bill-by-bill details (IsBillWiseOn) — name -> true/false; a name not found
// is absent. Tally silently drops a bill allocation sent to a ledger that does not (2026-10-23: 92 COD
// journals for customers whose ledgers were made outside this app on 7-8 Oct). 100 names a request.
export async function ledgersBillWise(names) {
  const out = new Map();
  const safe = [...new Set(names.filter(Boolean))].filter(quotable);
  for (let i = 0; i < safe.length; i += 100) {
    const chunk = safe.slice(i, i + 100);
    const xml = await post(envelope({
      id: 'HPZBillWise',
      tdl: `<SYSTEM TYPE="Formulae" NAME="HPZBillWiseIn">${chunk.map((n) => `$Name = ${q(n)}`).join(' OR ')}</SYSTEM>
<COLLECTION NAME="HPZBillWise" ISMODIFY="No"><TYPE>Ledger</TYPE><FILTER>HPZBillWiseIn</FILTER><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>IsBillWiseOn</NATIVEMETHOD></COLLECTION>`,
    }));
    for (const b of sliceBlocks(xml.slice(Math.max(0, xml.indexOf('<DATA>'))), 'LEDGER')) {
      const name = decodeEntities((b.match(/<LEDGER[^>]*\sNAME="([^"]*)"/) || [])[1] || '');
      if (name) out.set(name, scalar(b, 'ISBILLWISEON').toLowerCase() === 'yes');
    }
  }
  return out;
}

// Stock Journals between two dates: number, date, cancel flag, narration and the item names each brings IN
// (the destination side). A month per request, with the $Date filter. The RMS Movement tab checks its
// entries against this: a journal posted from another PC, or by hand, is not in this app's own history.
export async function stockJournalsInRange(fromYmd, toYmd) {
  const out = [];
  for (let f = fromYmd; f <= toYmd;) {
    const y = +f.slice(0, 4), m = +f.slice(4, 6);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10).replace(/-/g, '');
    const t = monthEnd < toYmd ? monthEnd : toYmd;
    const fl = tallyDateLiteral(f), tl = tallyDateLiteral(t);
    const xml = await post(envelope({
      id: 'HPZSjRange',
      staticVars: `<SVFROMDATE TYPE="Date">${fl}</SVFROMDATE><SVTODATE TYPE="Date">${tl}</SVTODATE>`,
      tdl: `<SYSTEM TYPE="Formulae" NAME="HPZSjRangeIn">$Date &gt;= $$Date:"${fl}" AND $Date &lt;= $$Date:"${tl}"</SYSTEM>
<COLLECTION NAME="HPZSjRange" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Stock Journal')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZSjRangeIn</FILTER><FETCH>VoucherNumber,Date,Narration,IsCancelled,InventoryEntriesIn.StockItemName</FETCH></COLLECTION>`,
    }));
    for (const v of sliceBlocks(xml.slice(Math.max(0, xml.indexOf('<DATA>'))), 'VOUCHER')) {
      const head = v.replace(/<([A-Z0-9]+(?:\.[A-Z0-9]+)*\.LIST)>[\s\S]*?<\/\1>/g, '');
      out.push({
        no: scalar(head, 'VOUCHERNUMBER'), date: scalar(head, 'DATE'), narration: scalar(head, 'NARRATION'),
        cancelled: scalar(head, 'ISCANCELLED').toLowerCase() === 'yes',
        items: sliceBlocks(v, 'INVENTORYENTRIESIN.LIST').map((e) => scalar(e, 'STOCKITEMNAME')).filter(Boolean),
      });
    }
    f = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10).replace(/-/g, '');
  }
  return out;
}

// The highest all-digit voucher number of one type (children included) between two dates, read a month
// per request, numbers only. Numbers follow ENTRY order, not voucher date: on 2026-10-23 Journal
// 1200435 was dated 28-Sep and 1200433 9-Sep, so the next free number needs the whole year.
// (One request for the whole year, without a $Date filter, did not finish in 3 minutes.)
export async function maxVoucherNumber(voucherType, fromYmd, toYmd) {
  let max = 0;
  for (let f = fromYmd; f <= toYmd;) {
    const y = +f.slice(0, 4), m = +f.slice(4, 6);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10).replace(/-/g, '');
    const t = monthEnd < toYmd ? monthEnd : toYmd;
    const fl = tallyDateLiteral(f), tl = tallyDateLiteral(t);
    const xml = await post(envelope({
      id: 'HPZMaxNo',
      staticVars: `<SVFROMDATE TYPE="Date">${fl}</SVFROMDATE><SVTODATE TYPE="Date">${tl}</SVTODATE>`,
      tdl: `<SYSTEM TYPE="Formulae" NAME="HPZMaxNoIn">$Date &gt;= $$Date:"${fl}" AND $Date &lt;= $$Date:"${tl}"</SYSTEM>
<COLLECTION NAME="HPZMaxNo" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q(voucherType)}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZMaxNoIn</FILTER><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD></COLLECTION>`,
    }));
    for (const mm of xml.matchAll(/<VOUCHERNUMBER>\s*(\d+)\s*<\/VOUCHERNUMBER>/g)) max = Math.max(max, Number(mm[1]));
    const n = new Date(Date.UTC(y, m, 1));
    f = n.toISOString().slice(0, 10).replace(/-/g, '');
  }
  return max;
}

// Journal-class vouchers between two dates — what the COD Import tab checks, since a COD collection is
// booked as a Journal whose narration is the AWB. Optional ones are listed too. `lines` adds each ledger
// line with its bill allocations (the read-back after posting); without it the read stays light:
// 1–22 Oct 2026 (~12k journals) in 4.6 s, and one day of 537 journals WITH lines in 0.3 s (2026-10-22).
export async function journalsInRange(fromYmd, toYmd, { lines = false } = {}) {
  const f = tallyDateLiteral(fromYmd), t = tallyDateLiteral(toYmd);
  const xml = await post(envelope({
    id: 'HPZJrnl',
    staticVars: `<SVFROMDATE TYPE="Date">${f}</SVFROMDATE><SVTODATE TYPE="Date">${t}</SVTODATE>`,
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZJrnlIn">$Date &gt;= $$Date:"${f}" AND $Date &lt;= $$Date:"${t}"</SYSTEM>
<COLLECTION NAME="HPZJrnl" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Journal')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZJrnlIn</FILTER><FETCH>VoucherNumber,Date,VoucherTypeName,MasterId,IsCancelled,IsOptional,Narration${lines
    ? ',AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount' : ''}</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  const yes = (s) => s.toLowerCase() === 'yes';
  return sliceBlocks(data, 'VOUCHER').map((v) => {
    const head = v.replace(/<([A-Z0-9]+(?:\.[A-Z0-9]+)*\.LIST)>[\s\S]*?<\/\1>/g, '');
    return {
      no: scalar(head, 'VOUCHERNUMBER'),
      date: scalar(head, 'DATE'),   // yyyymmdd
      type: scalar(head, 'VOUCHERTYPENAME'),
      masterId: scalar(head, 'MASTERID'),
      cancelled: yes(scalar(head, 'ISCANCELLED')),
      optional: yes(scalar(head, 'ISOPTIONAL')),
      narration: scalar(head, 'NARRATION'),
      lines: lines ? sliceBlocks(v, 'ALLLEDGERENTRIES.LIST').map((l) => ({
        ledger: scalar(l, 'LEDGERNAME'),
        amount: Number(scalar(l.replace(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g, ''), 'AMOUNT')) || 0,   // Cr +, Dr −
        bills: sliceBlocks(l, 'BILLALLOCATIONS.LIST').map((b) => ({ name: scalar(b, 'NAME'), type: scalar(b, 'BILLTYPE'), amount: Number(scalar(b, 'AMOUNT')) || 0 }))
          .filter((b) => b.name),
      })).filter((l) => l.ledger) : undefined,
    };
  });
}

// --- Purchases (Purchase Import tab) ----------------------------------------------------------------
// Tally prints a foreign-currency amount as "-$5397.30 @ Rs. 96.2159/$ = -Rs. 519306.08" and a rate as
// "$899.55 = Rs. 86551.01/Nos"; a rupee amount is a plain "-519306.08". -> { fx, rate, inr } (fx and
// rate null for rupees). Read off voucher #298 (BOE 4423722, 1964 EARS LLC), 2026-10-21.
export function parseAmount(s) {
  const t = String(s || '').trim();
  const m = /^(-?)(\D*?)([\d.,]+)\s*@\s*(?:Rs\.?|₹)\s*([\d.,]+)\/\S*\s*=\s*(-?)(?:Rs\.?|₹)\s*([\d.,]+)/.exec(t);
  const n = (x) => parseFloat(String(x).replace(/,/g, '')) || 0;
  // sym: the currency symbol the amount is in ("$", "S$", "€"…) — set per voucher line, not per ledger
  // (every import supplier ledger on Headphone Zone is in Rs.).
  if (m) return { fx: (m[1] ? -1 : 1) * n(m[3]), sym: m[2].trim(), rate: n(m[4]), inr: (m[5] ? -1 : 1) * n(m[6]) };
  return { fx: null, sym: null, rate: null, inr: n(t) };
}

// Supplier ledgers only (under Sundry Creditors) — lower-case name -> real name. Headphone Zone holds
// ~174,000 ledgers (one per customer email), 10 s to list them all; the creditors are a small slice.
export async function supplierLedgerNames() {
  const xml = await post(envelope({
    id: 'HPZCreditors',
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZIsCred">$$IsBelongsTo:$$GroupSundryCreditors</SYSTEM>
<COLLECTION NAME="HPZCreditors" ISMODIFY="No"><TYPE>Ledger</TYPE><FILTER>HPZIsCred</FILTER><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  const map = new Map();
  for (const m of xml.matchAll(/<LEDGER[^>]*\sNAME="([^"]*)"/g)) { const real = decodeEntities(m[1]); map.set(real.toLowerCase(), real); }
  return map;
}

// Every stock item with its group (Parent) and brand (Category) — what a new item from a BOE is
// suggested from. Plus the group and category masters, for the screen's dropdowns.
export async function stockItemsDetailed() {
  const xml = await post(envelope({
    id: 'HPZSIDet',
    tdl: `<COLLECTION NAME="HPZSIDet" ISMODIFY="No"><TYPE>StockItem</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>Category</NATIVEMETHOD></COLLECTION>`,
  }));
  return sliceBlocks(xml.slice(Math.max(0, xml.indexOf('<DATA>'))), 'STOCKITEM').map((b) => ({
    name: decodeEntities((b.match(/<STOCKITEM[^>]*\sNAME="([^"]*)"/) || [])[1] || ''), parent: scalar(b, 'PARENT'), category: scalar(b, 'CATEGORY'),
  })).filter((i) => i.name);
}
export async function stockGroupsAndCategories() {
  const names = async (type, id) => [...(await post(envelope({ id, tdl: `<COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>` })))
    .matchAll(new RegExp(`<${type.toUpperCase()}[^>]*\\sNAME="([^"]*)"`, 'g'))].map((m) => decodeEntities(m[1])).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return { groups: await names('StockGroup', 'HPZSG'), categories: await names('StockCategory', 'HPZSC') };
}

// A ledger's currency symbol ("$", "S$", "€"…; "" or "₹" for rupees). The BOE portal stores the invoice
// value in the invoice's own currency without saying which (IEF SPACES PTE LTD is at 76.35 — SGD), so
// the supplier ledger's currency in Tally is what a foreign voucher is written in.
export async function ledgerCurrency(name) {
  if (!quotable(name)) throw new Error(`ledger name "${name}" cannot be looked up safely`);
  const xml = await post(envelope({
    id: 'HPZLedCur',
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZLedCurF">$Name = ${q(name)}</SYSTEM>
<COLLECTION NAME="HPZLedCur" ISMODIFY="No"><TYPE>Ledger</TYPE><FILTER>HPZLedCurF</FILTER><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>CurrencyName</NATIVEMETHOD></COLLECTION>`,
  }));
  const led = sliceBlocks(xml.slice(Math.max(0, xml.indexOf('<DATA>'))), 'LEDGER')[0];
  return led ? scalar(led, 'CURRENCYNAME') : null;
}

// Every Purchase-class voucher (Purchase, Purchase Import, Expenses…) between two dates, header only:
// enough to spot a BOE already booked (narration / reference) and to find the latest import voucher.
export async function purchaseVouchersInRange(fromYmd, toYmd) {
  const f = tallyDateLiteral(fromYmd), t = tallyDateLiteral(toYmd);
  const xml = await post(envelope({
    id: 'HPZPurList',
    staticVars: `<SVFROMDATE TYPE="Date">${f}</SVFROMDATE><SVTODATE TYPE="Date">${t}</SVTODATE>`,
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZPurIn">$Date &gt;= $$Date:"${f}" AND $Date &lt;= $$Date:"${t}"</SYSTEM>
<COLLECTION NAME="HPZPurList" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Purchase')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZPurIn</FILTER><NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>Date</NATIVEMETHOD><NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD><NATIVEMETHOD>Reference</NATIVEMETHOD><NATIVEMETHOD>IsCancelled</NATIVEMETHOD><NATIVEMETHOD>IsOptional</NATIVEMETHOD><NATIVEMETHOD>MasterId</NATIVEMETHOD></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  return sliceBlocks(data, 'VOUCHER').map((v) => ({
    number: scalar(v, 'VOUCHERNUMBER'), date: scalar(v, 'DATE'), type: scalar(v, 'VOUCHERTYPENAME'),
    party: scalar(v, 'PARTYLEDGERNAME'), narration: scalar(v, 'NARRATION'), reference: scalar(v, 'REFERENCE'),
    cancelled: scalar(v, 'ISCANCELLED').toLowerCase() === 'yes', masterId: scalar(v, 'MASTERID').trim(),
    optional: scalar(v, 'ISOPTIONAL').toLowerCase() === 'yes',
  }));
}

// One purchase voucher in full, by MasterId (unique, unlike a voucher number) on its own date.
export async function readPurchaseVoucher(masterId, yyyymmdd) {
  if (!/^\d+$/.test(String(masterId).trim())) throw new Error(`bad MasterId "${masterId}"`);
  const xml = await post(envelope({
    id: 'HPZPurOne',
    staticVars: datedVars(yyyymmdd),
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZPurOneF">$MasterId = ${String(masterId).trim()}</SYSTEM>
<COLLECTION NAME="HPZPurOne" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Purchase')}</CHILDOF><BELONGSTO>Yes</BELONGSTO>
<FILTER>HPZPurOneF</FILTER><FETCH>VoucherNumber,Date,VoucherTypeName,ClassName,PartyLedgerName,Narration,Reference,ReferenceDate,PlaceOfSupply,CountryOfResidence,ConsigneeCountryName,ConsigneeStateName,ConsigneeMailingName,ConsigneeGSTIN,MasterId,IsCancelled,IsOptional,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsPartyLedger,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Rate,AllInventoryEntries.Amount,AllInventoryEntries.BatchAllocations.GodownName,AllInventoryEntries.BatchAllocations.BatchName,AllInventoryEntries.AccountingAllocations.LedgerName</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  const v = sliceBlocks(data, 'VOUCHER')[0];
  if (!v) return null;
  const head = v.replace(/<([A-Z0-9]+(?:\.[A-Z0-9]+)*\.LIST)>[\s\S]*?<\/\1>/g, '');
  return {
    number: scalar(head, 'VOUCHERNUMBER'), date: scalar(head, 'DATE'), type: scalar(head, 'VOUCHERTYPENAME'),
    className: scalar(head, 'CLASSNAME'), party: scalar(head, 'PARTYLEDGERNAME'), narration: scalar(head, 'NARRATION'),
    reference: scalar(head, 'REFERENCE'), referenceDate: scalar(head, 'REFERENCEDATE'),
    placeOfSupply: scalar(head, 'PLACEOFSUPPLY'), countryOfResidence: scalar(head, 'COUNTRYOFRESIDENCE'),
    consigneeCountry: scalar(head, 'CONSIGNEECOUNTRYNAME'), consigneeState: scalar(head, 'CONSIGNEESTATENAME'),
    consigneeName: scalar(head, 'CONSIGNEEMAILINGNAME'), consigneeGstin: scalar(head, 'CONSIGNEEGSTIN'),
    masterId: scalar(head, 'MASTERID').trim(), cancelled: scalar(head, 'ISCANCELLED').toLowerCase() === 'yes',
    optional: scalar(head, 'ISOPTIONAL').toLowerCase() === 'yes',
    // A voucher carries LEDGERENTRIES and ALLLEDGERENTRIES with the same lines; read the "ALL" ones.
    ledgers: sliceBlocks(v, 'ALLLEDGERENTRIES.LIST').map((e) => ({
      ledger: scalar(e, 'LEDGERNAME'), ...parseAmount(scalar(e, 'AMOUNT')), isParty: scalar(e, 'ISPARTYLEDGER').toLowerCase() === 'yes',
      bills: sliceBlocks(e, 'BILLALLOCATIONS.LIST').map((b) => ({ name: scalar(b, 'NAME'), type: scalar(b, 'BILLTYPE') })).filter((b) => b.name),
    })).filter((e) => e.ledger),
    items: sliceBlocks(v, 'ALLINVENTORYENTRIES.LIST').map((e) => {
      const bat = sliceBlocks(e, 'BATCHALLOCATIONS.LIST')[0] || '', acc = sliceBlocks(e, 'ACCOUNTINGALLOCATIONS.LIST')[0] || '';
      // Rate "$899.55 = Rs. 86551.01/Nos" -> 899.55 (the invoice-currency figure comes first).
      // price = per-unit in the invoice currency; rate (from the amount) = the exchange rate.
      const price = parseFloat((/([\d.,]+)/.exec(scalar(e, 'RATE')) || [])[1]?.replace(/,/g, '')) || 0;
      return { item: scalar(e, 'STOCKITEMNAME'), qty: parseFloat(scalar(e, 'BILLEDQTY')) || 0, price,
        ...parseAmount(scalar(e, 'AMOUNT')), godown: scalar(bat, 'GODOWNNAME'), batch: scalar(bat, 'BATCHNAME'), ledger: scalar(acc, 'LEDGERNAME') };
    }).filter((e) => e.item),
  };
}

// Tally stamps: '20261016' (a date) or '20261016104700000' (yyyymmddHHMMSSmmm, IST). '000000000' or
// empty = not set. Returned as an ISO string with the +05:30 offset, so no deadline lands 5½ h late.
function tallyStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?/.exec(String(s || '').trim());
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}+05:30`;
}

export async function vouchersOfType(voucherType, { withInventory = false, from = null, to = null } = {}) {
  const fields = withInventory
    ? `<FETCH>VoucherNumber,Date,PartyLedgerName,Narration,Reference,InventoryEntriesIn,InventoryEntriesOut</FETCH>`
    : `<NATIVEMETHOD>VoucherNumber</NATIVEMETHOD><NATIVEMETHOD>Date</NATIVEMETHOD>` +
      `<NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD><NATIVEMETHOD>Narration</NATIVEMETHOD>`;

  // SVFROMDATE/SVTODATE do not narrow this collection, so the window has to be
  // a FILTER on $Date. That still gathers every voucher of the type inside
  // Tally, but it keeps the inventory trees of everything outside the window
  // off the wire — which is where the memory goes.
  const windowed = from && to;
  const filter = windowed
    ? `<SYSTEM TYPE="Formulae" NAME="HPZInWindow">$Date >= $$Date:"${tallyDateLiteral(from)}" AND $Date &lt;= $$Date:"${tallyDateLiteral(to)}"</SYSTEM>`
    : '';

  const xml = await post(envelope({
    id: 'HPZVch',
    staticVars: `<SVFROMDATE>${PERIOD.from}</SVFROMDATE><SVTODATE>${PERIOD.to}</SVTODATE>`,
    tdl: `${filter}<COLLECTION NAME="HPZVch" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE>
<CHILDOF>${voucherType}</CHILDOF>${windowed ? '<FILTER>HPZInWindow</FILTER>' : ''}${fields}</COLLECTION>`,
  }));
  return parseVouchers(xml);
}

// --- XML reading -----------------------------------------------------------
// Tally emits a <VOUCHER>n</VOUCHER> *count* inside CMPINFO before the data,
// so voucher blocks are found by the opening tag WITH attributes.

function decodeEntities(s) {
  return s
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => (Number(d) < 32 ? '' : String.fromCharCode(Number(d))))
    .replace(/&amp;/g, '&')
    .trim();
}

function sliceBlocks(xml, tag) {
  const open = `<${tag}`, close = `</${tag}>`;
  const out = [];
  let i = 0;
  while ((i = xml.indexOf(open, i)) !== -1) {
    const after = xml[i + open.length];
    if (after !== ' ' && after !== '>') { i += open.length; continue; }
    const end = xml.indexOf(close, i);
    if (end === -1) break;
    out.push(xml.slice(i, end + close.length));
    i = end + close.length;
  }
  return out;
}

function scalar(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`);
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function parseInventory(block, listTag) {
  const entries = [];
  for (const e of sliceBlocks(block, listTag)) {
    const stockItem = scalar(e, 'STOCKITEMNAME');
    if (!stockItem) continue; // the unused side of a voucher is present but empty
    const batch = sliceBlocks(e, 'BATCHALLOCATIONS.LIST')[0] || '';
    entries.push({
      stockItem,
      actualQty: scalar(e, 'ACTUALQTY'),
      billedQty: scalar(e, 'BILLEDQTY'),
      godown: scalar(batch, 'GODOWNNAME'),
      batchName: scalar(batch, 'BATCHNAME'),
    });
  }
  return entries;
}

export function parseVouchers(xml) {
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  return sliceBlocks(data, 'VOUCHER').map((v) => ({
    voucherNumber: scalar(v, 'VOUCHERNUMBER'),
    date: scalar(v, 'DATE'),
    reference: scalar(v, 'REFERENCE'),
    party: scalar(v, 'PARTYLEDGERNAME'),
    narration: scalar(v, 'NARRATION'),
    inventoryIn: parseInventory(v, 'INVENTORYENTRIESIN.LIST'),
    inventoryOut: parseInventory(v, 'INVENTORYENTRIESOUT.LIST'),
  }));
}

// --- JSON writing ----------------------------------------------------------

export async function importVouchers(tallymessage) {
  const res = await serialize(() => fetch(TALLY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      TallyRequest: 'Import',
      Type: 'Data',
      Id: 'Vouchers',
    },
    body: encodeForTally(JSON.stringify({
      importdata: {
        requestdesc: { reportname: 'Vouchers' },
        requestdata: { tallymessage },
      },
    })),
    signal: AbortSignal.timeout(180000),
  }));
  const text = await res.text();
  try {
    // Tally leaves a non-numeric voucher number unquoted in its reply ("vchnumber": TEST-COD-1, 2026-10-22).
    return JSON.parse(text.replace(/("vchnumber"\s*:\s*)(?!["\d-])([^,}\r\n]*?)(\s*[,}\r\n])/g, '$1"$2"$3'));
  } catch {
    return { status: '0', error_list: [`unparseable response: ${text.slice(0, 300)}`] };
  }
}

// --- Credit notes ---------------------------------------------------------------------------------
// Rules learned the hard way (2026-09-30 / 10-01), all applied below:
//   * SVFROMDATE/SVTODATE narrow a voucher collection ONLY when written with TYPE="Date"; without it
//     the whole type is walked. A known date is therefore a cheap, bounded read.
//   * CHILDOF and FILTER values are formulas: a name is always passed as a quoted string literal, or a
//     name like ' pops a modal "Bad formula" box in Tally that blocks the gateway until someone clicks.
const q = (s) => `"${String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`;
const datedVars = (yyyymmdd) => `<SVFROMDATE TYPE="Date">${tallyDateLiteral(yyyymmdd)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDateLiteral(yyyymmdd)}</SVTODATE>`;
const datedRange = (fromYmd, toYmd) => `<SVFROMDATE TYPE="Date">${tallyDateLiteral(fromYmd)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDateLiteral(toYmd)}</SVTODATE>`;
const quotable = (s) => !/["\r\n]/.test(String(s));

// Which of these ledger names exist in the open company. One request; names containing a double
// quote cannot be matched safely and are reported as missing.
export async function existingLedgers(names) {
  const want = [...new Set(names.filter(Boolean))];
  const safe = want.filter(quotable);
  if (!safe.length) return new Set();
  const xml = await post(envelope({
    id: 'HPZLedChk',
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZLedIn">${safe.map((n) => `$Name = ${q(n)}`).join(' OR ')}</SYSTEM>
<COLLECTION NAME="HPZLedChk" ISMODIFY="No"><TYPE>Ledger</TYPE><FILTER>HPZLedIn</FILTER><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  return new Set([...xml.matchAll(/<LEDGER[^>]*\sNAME="([^"]*)"/g)].map((m) => decodeEntities(m[1])));
}

// Case-insensitive ledger lookup, for customer-email party ledgers specifically: Tally ledger names
// are unique case-INsensitively, but existingLedgers' plain $Name = "X" filter is case-sensitive, so
// an existing ledger in different casing is missed — a "new" one is then attempted and Tally rejects
// it as a duplicate name. Confirmed live, 2026-10-15: 3 of 4 batch-create failures were exactly this
// (e.g. "Shreyas.amar16@gmail.com" sent, "shreyas.amar16@gmail.com" already existed).
//
// A `$$String:Upper:$Name = $$String:Upper:"..."` FILTER was tried first and rejected after testing:
// it did not filter at all — returned all ~5,348 ledgers (37 MB, 32 s) instead of the one match. So
// this fetches every ledger name once (same cheap, unfiltered pattern as listStockItemNames) and
// compares case-insensitively in JS instead of trusting that TDL construct.
export async function allLedgerNamesByLower() {
  const xml = await post(envelope({
    id: 'HPZLedAll',
    tdl: `<COLLECTION NAME="HPZLedAll" ISMODIFY="No"><TYPE>Ledger</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>`,
  }));
  const map = new Map();
  for (const m of xml.matchAll(/<LEDGER[^>]*\sNAME="([^"]*)"/g)) {
    const real = decodeEntities(m[1]);
    map.set(real.toLowerCase(), real);
  }
  return map;
}


// The stock items (name + billed qty) on given credit-note numbers of one voucher type. Walks the
// type once with a scalar filter; item lists come back only for the matching vouchers.
export async function creditNoteItems(voucherType, numbers) {
  const safe = numbers.filter(quotable);
  if (!safe.length) return [];
  const xml = await post(envelope({
    id: 'HPZCnItems',
    staticVars: `<SVFROMDATE>${PERIOD.from}</SVFROMDATE><SVTODATE>${PERIOD.to}</SVTODATE>`,
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZCnNo">${safe.map((n) => `$VoucherNumber = ${q(n)}`).join(' OR ')}</SYSTEM>
<COLLECTION NAME="HPZCnItems" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q(voucherType)}</CHILDOF>
<FILTER>HPZCnNo</FILTER><FETCH>VoucherNumber,Date,IsCancelled,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  return sliceBlocks(data, 'VOUCHER').filter((v) => scalar(v, 'ISCANCELLED') !== 'Yes').map((v) => ({
    voucherNumber: scalar(v, 'VOUCHERNUMBER'),
    date: scalar(v, 'DATE'),
    items: sliceBlocks(v, 'ALLINVENTORYENTRIES.LIST').map((e) => ({ item: scalar(e, 'STOCKITEMNAME'), qty: parseFloat(scalar(e, 'BILLEDQTY')) || 0 })).filter((e) => e.item),
  }));
}

// Read one voucher back by type + number + date (bounded to that day), with what a posting must prove.
export async function readCreditNote(voucherType, number, yyyymmdd) {
  if (!quotable(number)) return null;
  const xml = await post(envelope({
    id: 'HPZCnRead',
    staticVars: datedVars(yyyymmdd),
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZCnOne">$VoucherNumber = ${q(number)}</SYSTEM>
<COLLECTION NAME="HPZCnRead" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q(voucherType)}</CHILDOF>
<FILTER>HPZCnOne</FILTER><FETCH>VoucherNumber,Date,VoucherTypeName,PartyLedgerName,Reference,CountryOfResidence,ConsigneeCountryName,GSTNatureOfReturn,StatusBeforeCreate,MasterId,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  const found = sliceBlocks(data, 'VOUCHER').filter((v) => scalar(v, 'DATE') === String(yyyymmdd));
  if (found.length !== 1) return found.length ? { duplicates: found.length } : null;
  const v = found[0];
  return {
    voucherNumber: scalar(v, 'VOUCHERNUMBER'), date: scalar(v, 'DATE'), type: scalar(v, 'VOUCHERTYPENAME'),
    party: scalar(v, 'PARTYLEDGERNAME'), reference: scalar(v, 'REFERENCE'),
    countryOfResidence: scalar(v, 'COUNTRYOFRESIDENCE'), consigneeCountry: scalar(v, 'CONSIGNEECOUNTRYNAME'),
    natureOfReturn: scalar(v, 'GSTNATUREOFRETURN'), statusBeforeCreate: scalar(v, 'STATUSBEFORECREATE'), masterId: scalar(v, 'MASTERID'),
    ledgers: sliceBlocks(v, 'ALLLEDGERENTRIES.LIST').map((e) => ({ ledger: scalar(e, 'LEDGERNAME'), amount: parseFloat(scalar(e, 'AMOUNT')) || 0 })).filter((e) => e.ledger),
    items: sliceBlocks(v, 'ALLINVENTORYENTRIES.LIST').map((e) => ({ item: scalar(e, 'STOCKITEMNAME'), qty: parseFloat(scalar(e, 'BILLEDQTY')) || 0, amount: parseFloat(scalar(e, 'AMOUNT')) || 0 })).filter((e) => e.item),
  };
}

// Read one Sales voucher back by number + date (bounded to that day), with what a posting must prove.
// Mirrors readCreditNote below — not yet written when this comment was added; kept here so the two
// read-backs stay side by side as the app grows more voucher types.
export async function readSalesVoucher(number, yyyymmdd) {
  if (!quotable(number)) return null;
  const xml = await post(envelope({
    id: 'HPZSaleRead',
    staticVars: datedVars(yyyymmdd),
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZSaleOne">$VoucherNumber = ${q(number)}</SYSTEM>
<COLLECTION NAME="HPZSaleRead" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Sales')}</CHILDOF>
<FILTER>HPZSaleOne</FILTER><FETCH>VoucherNumber,Date,VoucherTypeName,PartyLedgerName,Reference,MasterId,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  const found = sliceBlocks(data, 'VOUCHER').filter((v) => scalar(v, 'DATE') === String(yyyymmdd));
  if (found.length !== 1) return found.length ? { duplicates: found.length } : null;
  const v = found[0];
  return {
    voucherNumber: scalar(v, 'VOUCHERNUMBER'), date: scalar(v, 'DATE'), type: scalar(v, 'VOUCHERTYPENAME'),
    party: scalar(v, 'PARTYLEDGERNAME'), reference: scalar(v, 'REFERENCE'), masterId: scalar(v, 'MASTERID'),
    ledgers: sliceBlocks(v, 'ALLLEDGERENTRIES.LIST').map((e) => ({ ledger: scalar(e, 'LEDGERNAME'), amount: parseFloat(scalar(e, 'AMOUNT')) || 0 })).filter((e) => e.ledger),
    items: sliceBlocks(v, 'ALLINVENTORYENTRIES.LIST').map((e) => ({ item: scalar(e, 'STOCKITEMNAME'), qty: parseFloat(scalar(e, 'BILLEDQTY')) || 0, amount: parseFloat(scalar(e, 'AMOUNT')) || 0 })).filter((e) => e.item),
  };
}

// Read many Sales vouchers back at once by number, scoped to a date range (typed dates — proven to
// narrow). Same OR-filter batching pattern as creditNoteItems; cap each call at <=200 numbers. Built
// for high-volume batch posting, where reading one voucher back per gateway call does not scale.
export async function readSalesVouchersBatch(numbers, fromYmd, toYmd) {
  const safe = numbers.filter(quotable);
  if (!safe.length) return [];
  const xml = await post(envelope({
    id: 'HPZSaleBatch',
    staticVars: datedRange(fromYmd, toYmd),
    tdl: `<SYSTEM TYPE="Formulae" NAME="HPZSaleBatchF">${safe.map((n) => `$VoucherNumber = ${q(n)}`).join(' OR ')}</SYSTEM>
<COLLECTION NAME="HPZSaleBatch" ISMODIFY="No"><TYPE>Vouchers : VoucherType</TYPE><CHILDOF>${q('Sales')}</CHILDOF>
<FILTER>HPZSaleBatchF</FILTER><FETCH>VoucherNumber,Date,VoucherTypeName,PartyLedgerName,Reference,MasterId,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllInventoryEntries.StockItemName,AllInventoryEntries.BilledQty,AllInventoryEntries.Amount</FETCH></COLLECTION>`,
  }));
  const data = xml.slice(Math.max(0, xml.indexOf('<DATA>')));
  return sliceBlocks(data, 'VOUCHER').map((v) => ({
    voucherNumber: scalar(v, 'VOUCHERNUMBER'), date: scalar(v, 'DATE'),
    party: scalar(v, 'PARTYLEDGERNAME'), reference: scalar(v, 'REFERENCE'), masterId: scalar(v, 'MASTERID'),
    ledgers: sliceBlocks(v, 'ALLLEDGERENTRIES.LIST').map((e) => ({ ledger: scalar(e, 'LEDGERNAME'), amount: parseFloat(scalar(e, 'AMOUNT')) || 0 })).filter((e) => e.ledger),
    items: sliceBlocks(v, 'ALLINVENTORYENTRIES.LIST').map((e) => ({ item: scalar(e, 'STOCKITEMNAME'), qty: parseFloat(scalar(e, 'BILLEDQTY')) || 0, amount: parseFloat(scalar(e, 'AMOUNT')) || 0 })).filter((e) => e.item),
  }));
}

// Create or alter masters (ledgers) via JSON import. Mirrors importVouchers exactly except for the
// report name — NOT YET PROVEN against this gateway the way importVouchers is (that one has been
// posting real Credit Notes and Material Outs for weeks; this has not been exercised). Test on a
// disposable company first: create one ledger, then read it back with existingLedgers before trusting
// this for real customer-ledger creation.
export async function importMasters(tallymessage) {
  const res = await serialize(() => fetch(TALLY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      TallyRequest: 'Import',
      Type: 'Data',
      Id: 'All Masters',
    },
    body: encodeForTally(JSON.stringify({
      importdata: {
        requestdesc: { reportname: 'All Masters' },
        requestdata: { tallymessage },
      },
    })),
    signal: AbortSignal.timeout(180000),
  }));
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: '0', error_list: [`unparseable response: ${text.slice(0, 300)}`] };
  }
}

// Shape verified field-for-field against 49 vouchers the retired vendor TCP left
// behind. isdeemedpositive is explicit on both sides: Tally does not infer the
// side from the array name and silently files the entry on the wrong one.
export function materialOutVoucher({ wcid, date, party, narration, stockItem, qty, godown, batchName }) {
  const quantity = qty || ' 1.0 Nos';
  return {
    metadata: {
      type: 'Voucher',
      vchtype: 'Material Out',
      action: 'Create',
      objview: 'Multi Consumption Voucher View',
    },
    date,
    effectivedate: date,
    vouchertypename: 'Material Out',
    vouchernumber: `${wcid}_MO`,
    reference: wcid,
    narration,
    partyledgername: party,
    basicbasepartyname: party,
    persistedview: 'Multi Consumption Voucher View',
    isinvoice: false,
    ledgerentries: [
      { ledgername: party, isdeemedpositive: true, amount: '0.00' },
    ],
    inventoryentriesout: [
      {
        stockitemname: stockItem,
        isdeemedpositive: false,
        actualqty: quantity,
        billedqty: quantity,
        batchallocations: [
          {
            godownname: godown || 'Service Godown',
            batchname: batchName || 'Primary Batch',
            actualqty: quantity,
            billedqty: quantity,
          },
        ],
      },
    ],
  };
}
