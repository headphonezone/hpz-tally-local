import { fetchBook } from './feed.mjs';
import { activeCompany, vouchersOfType, voucherNumbersOfType } from './tally.mjs';

// Sheet WCID == Material In VoucherNumber, exactly. The Out is <WCID>_MO.
//
// Three fetches, deliberately different shapes, because full-financial-year
// requests hang Tally:
//   Material Out  - numbers only, WHOLE company. This is the duplicate guard,
//                   and a date window would break it: an Out dated outside the
//                   window reads as missing and the voucher gets created twice.
//                   Numbers-only keeps it cheap enough not to need one.
//   Material In   - numbers only, whole company, to tell "does not exist" apart
//                   from "exists but outside the window".
//   Material In   - full detail, windowed. This is the expensive fetch, so it
//                   is the one that gets bounded.

export const LOOKBACK_MONTHS = 3;

// A unit is received before it is dispatched, so the Material In window has to
// start earlier than the sheet's closure-date window. Three months of lookback.
export function lookbackFrom(yyyymmdd, months = LOOKBACK_MONTHS) {
  const s = String(yyyymmdd);
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function buildReport({ book = 'live', from, to } = {}) {
  const startedAt = Date.now();
  if (!from || !to) throw new Error('a from and to date are required');

  const miFrom = lookbackFrom(from);

  // The sheet lives on Google, so it can run alongside. The Tally calls must
  // not: overlapping requests wedge the gateway.
  const sheetPromise = fetchBook(book, { from, to });

  const company = await activeCompany();
  const miDetailed = await vouchersOfType('Material In', { withInventory: true, from: miFrom, to });
  const miAllNumbers = await voucherNumbersOfType('Material In');
  const moNumbers = await voucherNumbersOfType('Material Out');
  const sheet = await sheetPromise;

  const inByNumber = new Map(miDetailed.map((v) => [v.voucherNumber, v]));
  const inAnywhere = new Set(miAllNumbers);
  const existingOut = new Set(moNumbers);

  const rows = sheet.map((r) => {
    const mi = inByNumber.get(r.WCID);
    const moNumber = `${r.WCID}_MO`;
    // Copy the item from the Material In, never the sheet's Product column:
    // it is a display name that matches the Tally SKU in a minority of rows.
    const item = mi?.inventoryIn?.[0];

    const row = {
      wcid: r.WCID,
      source: r.SRC,
      sheetDate: r.RDATE,
      tallyDate: r.tallyDate,
      sheetEmail: r.EMAIL,
      customer: r.NAME,
      sheetProduct: r.PROD,
      moNumber,
      status: 'ready',
      reason: '',
      mi: mi && {
        date: mi.date,
        party: mi.party,
        narration: mi.narration,
        stockItem: item?.stockItem || '',
        qty: item?.actualQty || '',
        godown: item?.godown || '',
        batchName: item?.batchName || '',
      },
    };

    if (existingOut.has(moNumber)) {
      row.status = 'done';
    } else if (!mi) {
      row.status = 'blocked';
      row.reason = inAnywhere.has(r.WCID)
        ? `Material In ${r.WCID} exists but is dated outside the ${LOOKBACK_MONTHS}-month lookback — widen the date range`
        // A unit received in the previous financial year has its Material In in
        // the previous company, which this one cannot see.
        : `no Material In numbered ${r.WCID} in this company`;
    } else if (!r.tallyDate) {
      row.status = 'blocked';
      row.reason = `closure date will not parse: "${r.RDATE || '(empty)'}"`;
    } else if (!item?.stockItem) {
      row.status = 'blocked';
      row.reason = 'Material In carries no stock item to copy';
    }
    return row;
  });

  const counts = { ready: 0, done: 0, blocked: 0 };
  for (const r of rows) counts[r.status]++;

  return {
    builtAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    company,
    book,
    range: { from, to, materialInFrom: miFrom },
    counts,
    totals: {
      sheetRows: sheet.length,
      materialIn: miDetailed.length,
      materialInAll: inAnywhere.size,
      materialOut: existingOut.size,
    },
    rows,
  };
}
