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
      body,
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`Tally HTTP ${res.status}`);
    return res.text();
  });
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
    body: JSON.stringify({
      importdata: {
        requestdesc: { reportname: 'Vouchers' },
        requestdata: { tallymessage },
      },
    }),
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
