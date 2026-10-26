// Stock Journal: build, validate, post and verify. Tally access goes only through lib/tally.mjs,
// so every call shares its one-at-a-time queue with the Material Out side of this app.
//
// A journal moves returned stock between godowns, quantity only (no rate, no amount):
//   Source (Consumption)       the item at the From godown        isdeemedpositive: false
//   Destination (Production)   the same item — or "Unboxed - <item>" — at the To godown
//                                                                   isdeemedpositive: true
// An RMS replacement can differ on the source side: an unboxed unit leaving ("Unboxed - <item>"), or
// another product than the one arriving (see validateNames).
// isdeemedpositive is explicit on both sides: Tally does not infer the side from the array name
// and silently files a line on the wrong one if it is missing.

import { stockItemUnits, voucherNumbersOfType, importVouchers, vouchersOfType } from './tally.mjs';

export const VCHTYPE = 'Stock Journal';
export const UNBOXED_PREFIX = 'Unboxed - ';
export const GODOWNS = ['Service Godown', 'Chennai Wh -Good', 'Def'];

// RMS Movement of Stock → Stock Journal. RMS sends each condition's route with the batch (from/to
// godown, which side is unboxed), covering repaired units and WCID replacements too. This table is
// only the fallback for an RMS from before it sent routes, when everything logged there left the
// Service Godown and the condition decided where it went. Unbox lands in the good warehouse under its
// "Unboxed - <item>" name, exactly like ticking Unboxed on a hand-made journal.
export const MOVEMENT_FROM = 'Service Godown';
export const MOVEMENT_ROUTE = {
  Good:      { toGodown: 'Chennai Wh -Good', unboxed: false },
  Unbox:     { toGodown: 'Chennai Wh -Good', unboxed: true },
  Defective: { toGodown: 'Def',              unboxed: false },
};

// An item that is ALREADY an "Unboxed - ..." item moves as itself: no second "Unboxed - " is put in front of it
// (RET77571, 2026-10-24: RMS sent "Unboxed - KZ - CASTOR - PRO - ..."). Every other item gets the prefix as before.
export const isUnboxedName = (item) => /^\s*Unboxed\s*-/i.test(String(item));
export const destName = (item, unboxed) => (unboxed && !isUnboxedName(item) ? `${UNBOXED_PREFIX}${item}` : item);

// Same item across several references becomes one line with the quantities summed — the way the
// accounts team's own journals combine many RETs of one product. `item` is the product arriving;
// `fromItem` the product leaving, when it isn't the same (an RMS replacement of another product).
export function aggregate(entries) {
  const byPair = new Map();
  for (const e of entries) {
    if (!e.item) continue;
    const fromItem = e.fromItem || e.item;
    const key = `${fromItem}\u0000${e.item}`;
    const line = byPair.get(key) || { item: e.item, fromItem, qty: 0 };
    line.qty += Number(e.qty) || 0;
    byPair.set(key, line);
  }
  return [...byPair.values()];
}

// Tally stock item names are unique ignoring case, so RMS's "KZ - CASTOR - PRO - ..." is Tally's "KZ - Castor - Pro - ..."
// (2026-10-24: 8 Unbox cases refused 'name not matched' for capitals alone).
// Spacing around hyphens is ignored too: Tally has an item "Unboxed -KZ - Duonic - 4 - ..." (no space after the
// first hyphen) where the app looked for "Unboxed - KZ - Duonic - 4 - ..." (2026-10-26, RET78162).
const normalizeWs = (s) => String(s).replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

// Every source name and every destination name must exist in Tally exactly. They differ when a side
// is unboxed ("Unboxed - <item>": arriving unboxed, or an unboxed unit leaving) or when a replacement
// is another product (`fromItem`). A name that only differs from a Tally item by whitespace (RMS has
// shipped double-spaced names, e.g. "Mic  - In-Ear") is accepted, but the line is always rewritten to
// Tally's own spelling before posting — never RMS's — so a stray space can't make Tally silently
// create a near-duplicate stock item. Each resolved line carries `from` and `to`, the exact names
// posted, and `fromUnit`/`toUnit`, each item's own base unit (a quantity in another unit is not taken).
// An item with no unit ("Not Applicable") is refused (`noUnit`): Tally would keep its line at quantity
// 0. `items` (name -> unit, or a plain list of Nos items) is for tests; it is read from Tally otherwise.
export async function validateNames(lines, unboxed, fromUnboxed = false, items = null) {
  const units = items instanceof Map ? items
    : Array.isArray(items) ? new Map(items.map((n) => [n, 'Nos']))
    : await stockItemUnits();
  const all = [...units.keys()];
  const names = new Set(all);
  const byNormalized = new Map(all.map((n) => [normalizeWs(n), n]));
  const resolve = (item) => (names.has(item) ? item : byNormalized.get(normalizeWs(item)));
  const unitOf = (name) => {
    const u = String(units.get(name) || '').trim();
    return u && !/not applicable/i.test(u) ? u : null;
  };

  const unmatched = [];
  const noUnit = [];
  const resolved = [];
  for (const l of lines) {
    const wantFrom = destName(l.fromItem || l.item, fromUnboxed);
    const wantTo = destName(l.item, unboxed);
    const from = resolve(wantFrom);
    const to = resolve(wantTo);
    if (!from) unmatched.push({ item: wantFrom, side: 'source' });
    if (!to && wantTo !== wantFrom) unmatched.push({ item: wantTo, side: 'destination' });
    if (!from || !to) continue;
    const fromUnit = unitOf(from), toUnit = unitOf(to);
    if (!fromUnit) noUnit.push({ item: from, side: 'source' });
    if (!toUnit && to !== from) noUnit.push({ item: to, side: 'destination' });
    // `item` stays the plain product arriving (Tally's spelling when it resolves), for history and the
    // duplicate rule; `from`/`to` are what the voucher carries.
    if (fromUnit && toUnit) resolved.push({ ...l, item: resolve(l.item) || l.item, from, to, fromUnit, toUnit });
  }
  return { ok: unmatched.length === 0 && noUnit.length === 0, unmatched, noUnit, lines: resolved };
}

const yyyymmdd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export function buildVoucher({ voucherNumber, date, fromGodown, toGodown, unboxed, narration, lines }) {
  // In the item's own unit: Tally does not take a quantity given in another one.
  const qtyOf = (q, unit) => ` ${Number(q).toFixed(1)} ${unit || 'Nos'}`;
  const entry = (item, godown, deemedPositive, qty, unit) => ({
    stockitemname: item,
    isdeemedpositive: deemedPositive,
    actualqty: qtyOf(qty, unit),
    billedqty: qtyOf(qty, unit),
    batchallocations: [{ godownname: godown, batchname: 'Primary Batch', actualqty: qtyOf(qty, unit), billedqty: qtyOf(qty, unit) }],
  });
  return {
    metadata: { type: 'Voucher', vchtype: VCHTYPE, action: 'Create' },
    date: yyyymmdd(date),
    effectivedate: yyyymmdd(date),
    vouchertypename: VCHTYPE,
    vouchernumber: voucherNumber,
    narration,
    // `from`/`to` come from validateNames; lines without them are the plain item (and its unboxed
    // destination) exactly as before.
    inventoryentriesout: lines.map((l) => entry(l.from || l.item, fromGodown, false, l.qty, l.fromUnit)),
    inventoryentriesin: lines.map((l) => entry(l.to || destName(l.item, unboxed), toGodown, true, l.qty, l.toUnit)),
  };
}

// Does a journal's narration name this reference, as a whole? "RET7305" is not in "RET73051", and a ref
// with hyphens — an RMA number like "RMA-2026-10208", which Movement of Stock accepts — still matches
// (splitting the narration on every non-alphanumeric broke it into pieces and never matched).
export function narrationNames(narration, reference) {
  const ref = String(reference || '').trim();
  if (!ref) return false;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}($|[^A-Za-z0-9-])`, 'i').test(String(narration || ''));
}

// What a Stock Journal holds, as comparable lines: "item@godown qty" per side, whitespace-normalised.
const sideLines = (entries, name, godown, qty) =>
  entries.map((e) => `${normalizeWs(name(e))}@${godown(e)} ${Math.abs(parseFloat(String(qty(e)).replace(/[^0-9.\-]/g, '')) || 0)}`).sort();

// The voucher as Tally holds it against the one sent: the same items, godowns and quantities on each
// side. Empty when they agree; otherwise one line per difference.
export function compareVoucher(sent, held) {
  const fromSent = (side) => sideLines(sent[side], (e) => e.stockitemname, (e) => e.batchallocations[0].godownname, (e) => e.actualqty);
  const fromHeld = (list) => sideLines(list, (e) => e.stockItem, (e) => e.godown, (e) => e.actualQty);
  const diffs = [];
  for (const [label, s, h] of [['out', fromSent('inventoryentriesout'), fromHeld(held.inventoryOut)],
    ['in', fromSent('inventoryentriesin'), fromHeld(held.inventoryIn)]]) {
    if (JSON.stringify(s) !== JSON.stringify(h)) diffs.push(`${label}: sent ${s.join(', ') || '—'}; Tally has ${h.join(', ') || '—'}`);
  }
  return diffs;
}

// The numbers already used by Stock Journals in the open company.
export async function takenNumbers() {
  return new Set(await voucherNumbersOfType(VCHTYPE));
}

// The highest RMS-N among those numbers, or 0 if the company has none yet. Anything that is not
// exactly "RMS-<digits>" (Tally's own 1186, RMS-7A, …) is not part of this series and is ignored.
export function highestRms(taken) {
  let max = 0;
  for (const n of taken) {
    const m = /^RMS-(\d+)$/.exec(String(n).trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// Import, then decide success by reading the voucher back. A clean import_result proves nothing:
// Tally has reported success for a voucher whose lines landed on the wrong side, a voucher type set
// to Automatic numbering would silently renumber RMS-N, and a line in a unit Tally doesn't take is
// kept at quantity 0. The read-back is the truth: the number must exist, and its lines must be the
// ones sent (`mismatch` lists what differs; the voucher then exists but is wrong).
export async function postAndVerify(voucher) {
  let response;
  try {
    response = await importVouchers([voucher]);
  } catch (err) {
    return { created: false, response: { status: '0', error_list: [err.message] }, error: err.message };
  }
  const after = await takenNumbers();
  const created = after.has(voucher.vouchernumber);
  if (!created) return { created, response, error: describeFailure(response) };

  const held = (await vouchersOfType(VCHTYPE, { withInventory: true, from: voucher.date, to: voucher.date }))
    .find((v) => v.voucherNumber === voucher.vouchernumber);
  const mismatch = held ? compareVoucher(voucher, held) : ['could not read the voucher back from Tally'];
  return {
    created, response, mismatch,
    error: mismatch.length ? `${voucher.vouchernumber} is in Tally but not as sent — ${mismatch.join(' / ')}. Correct or delete it in Tally.` : '',
  };
}

function describeFailure(r) {
  if (!r) return 'no response from Tally';
  if (Array.isArray(r.error_list) && r.error_list.length) return r.error_list.join('; ');
  const errors = r.data?.import_result?.errors ?? r.data?.errors;
  if (errors) return `Tally reported ${errors} error(s); the voucher is not in Tally`;
  return 'the voucher is not in Tally after import — if the Stock Journal voucher type uses Automatic numbering, switch it to Manual so RMS-N is kept';
}
