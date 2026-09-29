// Stock Journal: build, validate, post and verify. Tally access goes only through lib/tally.mjs,
// so every call shares its one-at-a-time queue with the Material Out side of this app.
//
// A journal moves returned stock between godowns, quantity only (no rate, no amount):
//   Source (Consumption)       the item at the From godown        isdeemedpositive: false
//   Destination (Production)   the same item — or "Unboxed - <item>" — at the To godown
//                                                                   isdeemedpositive: true
// isdeemedpositive is explicit on both sides: Tally does not infer the side from the array name
// and silently files a line on the wrong one if it is missing.

import { listStockItemNames, voucherNumbersOfType, importVouchers } from './tally.mjs';

export const VCHTYPE = 'Stock Journal';
export const UNBOXED_PREFIX = 'Unboxed - ';
export const GODOWNS = ['Service Godown', 'Chennai Wh -Good', 'Def'];

export const destName = (item, unboxed) => (unboxed ? `${UNBOXED_PREFIX}${item}` : item);

// Same item across several references becomes one line with the quantities summed — the way the
// accounts team's own journals combine many RETs of one product.
export function aggregate(entries) {
  const byItem = new Map();
  for (const e of entries) {
    if (!e.item) continue;
    byItem.set(e.item, (byItem.get(e.item) || 0) + (Number(e.qty) || 0));
  }
  return [...byItem.entries()].map(([item, qty]) => ({ item, qty }));
}

// Every source item, and every destination name (which differs when unboxing), must exist in
// Tally exactly. Any miss blocks the whole posting.
export async function validateNames(lines, unboxed) {
  const names = new Set(await listStockItemNames());
  const unmatched = [];
  for (const l of lines) {
    if (!names.has(l.item)) unmatched.push({ item: l.item, side: 'source' });
    if (unboxed && !names.has(destName(l.item, true))) unmatched.push({ item: destName(l.item, true), side: 'destination' });
  }
  return { ok: unmatched.length === 0, unmatched };
}

const yyyymmdd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export function buildVoucher({ voucherNumber, date, fromGodown, toGodown, unboxed, narration, lines }) {
  const nos = (q) => ` ${Number(q).toFixed(1)} Nos`;
  const entry = (item, godown, deemedPositive, qty) => ({
    stockitemname: item,
    isdeemedpositive: deemedPositive,
    actualqty: nos(qty),
    billedqty: nos(qty),
    batchallocations: [{ godownname: godown, batchname: 'Primary Batch', actualqty: nos(qty), billedqty: nos(qty) }],
  });
  return {
    metadata: { type: 'Voucher', vchtype: VCHTYPE, action: 'Create' },
    date: yyyymmdd(date),
    effectivedate: yyyymmdd(date),
    vouchertypename: VCHTYPE,
    vouchernumber: voucherNumber,
    narration,
    inventoryentriesout: lines.map((l) => entry(l.item, fromGodown, false, l.qty)),
    inventoryentriesin: lines.map((l) => entry(destName(l.item, unboxed), toGodown, true, l.qty)),
  };
}

// The numbers already used by Stock Journals in the open company.
export async function takenNumbers() {
  return new Set(await voucherNumbersOfType(VCHTYPE));
}

// Import, then decide success by reading the voucher back. A clean import_result proves nothing:
// Tally has reported success for a voucher whose lines landed on the wrong side, and a voucher
// type set to Automatic numbering would silently renumber RMS-N. The read-back is the truth.
export async function postAndVerify(voucher) {
  let response;
  try {
    response = await importVouchers([voucher]);
  } catch (err) {
    return { created: false, response: { status: '0', error_list: [err.message] }, error: err.message };
  }
  const after = await takenNumbers();
  const created = after.has(voucher.vouchernumber);
  return { created, response, error: created ? '' : describeFailure(response) };
}

function describeFailure(r) {
  if (!r) return 'no response from Tally';
  if (Array.isArray(r.error_list) && r.error_list.length) return r.error_list.join('; ');
  const errors = r.data?.import_result?.errors ?? r.data?.errors;
  if (errors) return `Tally reported ${errors} error(s); the voucher is not in Tally`;
  return 'the voucher is not in Tally after import — if the Stock Journal voucher type uses Automatic numbering, switch it to Manual so RMS-N is kept';
}
