// Purchase Import in Ferrari Video: the sale of the same goods to Headphone Zone, booked in FV together with the import.
//
// FV buys the goods in USD (Purchase Import); Headphone Zone then buys them from FV in rupees, and FV books that as a Sales
// invoice. This module builds that invoice from the same BOE:
//   * rate    = the BOE Costing Portal's "+2% MARGIN" value per piece (lib/costing.mjs), qty x rate = the line;
//   * layout  = copied from FV's latest Sales voucher to Headphone Zone (read from Tally, like the import purchase copies the
//               latest import): voucher type, buyer, sales ledger, CGST/SGST ledgers, TDS and rounding ledgers, godown, batch;
//   * number  = the next one of that voucher's series (FVC/26-27/0175 -> FVC/26-27/0176);
//   * tax     = what that voucher shows: GST on each line, rounded per line as Tally does (checked against FVC/26-27/0175:
//               CGST 65,397.22 = the sum of 12 lines each rounded, not 9% of the total 65,397.21), TDS receivable at the
//               template's rate on the taxable value rounded to the rupee, the party total rounded to the rupee.
// A BOE posted directly in Headphone Zone has no sale — this is only for the FV company.
//
// Verified against FV's FVC/26-27/0175 (31-Oct-2026): Sale GST 726,635.69; Output CGST/SGST @9% 65,397.22 each; Tds
// Receivable on Sale -727.00 (0.1%); Rounding Off -0.13; party -856,703.00 with bill New Ref = the voucher number.

import { boeDb, IMPORT_VOUCHER_TYPE } from './purchase.mjs';
import { costBoe } from './costing.mjs';
import { salesWithParty, readSaleFull, readSalesVouchersBatch, readPurchaseVoucher } from './tally.mjs';

export const BUYER = /headphone zone priv/i;   // "Headphone Zone Private Limited", not "Headphonezone Services"

const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const money = (x) => round2(x).toFixed(2);
const nos = (q) => ` ${Number(q).toFixed(1)} Nos`;
const ymd8 = (iso) => String(iso).slice(0, 10).replace(/-/g, '');

// --- the portal's costing of a BOE ------------------------------------------------------------------------
export async function fetchBoeCosting(beNo) {
  const e = encodeURIComponent(String(beNo).trim());
  const [boe] = await boeDb.sb(`boes?select=be_no,exchange_rate,freight_inr,insurance_inr,misc_charges_inr&be_no=eq.${e}`);
  if (!boe) throw new Error(`BOE ${beNo} is not in the BOE Costing Portal`);
  const items = await boeDb.sb(`boe_items?select=invsno,itemsn,description,unit_price_usd,qty,bcd,bcd_forgone,sws&be_no=eq.${e}&order=invsno.asc,itemsn.asc`);
  let variable = null;
  try { [variable = null] = await boeDb.sb(`boe_variable_fields?select=*&be_no=eq.${e}`); } catch { /* no variable-fields table: the portal's defaults */ }
  return costBoe({ boe, items, variable });
}

// --- the layout: FV's latest sale to Headphone Zone ------------------------------------------------------
const numParts = (n) => { const m = /^(.*?)(\d+)$/.exec(String(n).trim()); return m ? { prefix: m[1], n: Number(m[2]), width: m[2].length } : null; };

// The next number of the template voucher's series, past every number in `taken`.
export function nextNumber(templateNumber, taken) {
  const t = numParts(templateNumber);
  if (!t) return null;
  let max = t.n;
  for (const n of taken) { const p = numParts(n); if (p && p.prefix === t.prefix && p.n > max) max = p.n; }
  return `${t.prefix}${String(max + 1).padStart(t.width, '0')}`;
}

// From the voucher itself: which ledger is which. Returns { template } or { problems }.
export function templateFrom(v) {
  const problems = [];
  const party = v.ledgers.find((l) => l.isParty);
  const tax = (kind) => v.ledgers.find((l) => new RegExp(`^output ${kind}\\b`, 'i').test(l.ledger));
  const cgst = tax('cgst'), sgst = tax('sgst');
  const rate = (l) => { const m = /(\d+(?:\.\d+)?)\s*%/.exec(l?.ledger || ''); return m ? Number(m[1]) : null; };
  const tds = v.ledgers.find((l) => /^tds/i.test(l.ledger));
  const rounding = v.ledgers.find((l) => /round/i.test(l.ledger));
  const salesLedger = v.items[0]?.ledger, godown = v.items[0]?.godown;
  if (!party) problems.push('no party line');
  if (!salesLedger) problems.push('no sales ledger on its items');
  if (!godown) problems.push('no godown on its items');
  if (!cgst || !sgst || rate(cgst) == null || rate(sgst) == null) problems.push('no Output CGST / SGST ledger with a rate');
  const taxable = v.ledgers.filter((l) => l.ledger === salesLedger).reduce((s, l) => s + l.amount, 0);
  if (problems.length) return { problems };
  return {
    template: {
      from: v.number, voucherType: v.type || 'Sales', party: party.ledger, mailingName: v.mailingName || party.ledger,
      placeOfSupply: v.placeOfSupply, gstRegistrationType: v.gstRegistrationType, partyGstin: v.partyGstin,
      consigneeState: v.consigneeState || v.placeOfSupply, consigneeGstin: v.consigneeGstin || v.partyGstin,
      salesLedger, godown, batch: v.items[0].batch || 'Primary Batch',
      cgst: { ledger: cgst.ledger, pct: rate(cgst) }, sgst: { ledger: sgst.ledger, pct: rate(sgst) },
      // The TDS the buyer deducts, as a % of the taxable value (0.1): only when the template has one.
      tds: tds && taxable > 0 ? { ledger: tds.ledger, pct: Math.round((-tds.amount / taxable) * 100 * 1000) / 1000 } : null,
      rounding: rounding?.ledger || null,
    },
  };
}

// Latest non-cancelled sale to Headphone Zone in the open company (FV) + every number already used.
export async function readSaleTemplate(fromIso, toIso) {
  const all = await salesWithParty(ymd8(fromIso), ymd8(toIso));
  const taken = new Set(all.map((v) => v.number));
  const mine = all.filter((v) => BUYER.test(v.party) && !v.cancelled && !v.optional);
  if (!mine.length) return { problems: ['no earlier sale to Headphone Zone found in this company to copy the layout from'], taken };
  const key = (v) => `${v.date}${String(numParts(v.number)?.n ?? 0).padStart(8, '0')}`;
  const latest = mine.sort((a, b) => key(a).localeCompare(key(b))).at(-1);
  const full = await readSaleFull(latest.masterId, latest.date);
  if (!full) return { problems: [`could not read ${latest.number} back from Tally`], taken };
  return { ...templateFrom(full), taken };
}

// --- the money ----------------------------------------------------------------------------------------------
// `lines`: [{ item, qty, rate }]. GST is rounded per line (as Tally does), TDS to the rupee, the party total to the rupee.
export function computeSale(lines, template) {
  const rows = lines.map((l) => {
    const amount = round2(l.qty * l.rate);
    return { ...l, amount, cgst: round2(amount * template.cgst.pct / 100), sgst: round2(amount * template.sgst.pct / 100) };
  });
  const taxable = round2(rows.reduce((s, r) => s + r.amount, 0));
  const cgst = round2(rows.reduce((s, r) => s + r.cgst, 0)), sgst = round2(rows.reduce((s, r) => s + r.sgst, 0));
  const tds = template.tds ? Math.round(taxable * template.tds.pct / 100) : 0;
  const exact = round2(taxable + cgst + sgst - tds);
  const party = Math.round(exact);
  return { rows, taxable, cgst, sgst, tds, rounding: round2(party - exact), party };
}

// --- the voucher --------------------------------------------------------------------------------------------
export function buildSaleVoucher({ template: t, number, date, sale, optional = false }) {
  const bill = money(-sale.party);
  const ledgerentries = [
    { ledgername: t.party, isdeemedpositive: true, ispartyledger: true, amount: bill,
      billallocations: [{ name: number, billtype: 'New Ref', amount: bill }] },
    { ledgername: t.cgst.ledger, isdeemedpositive: false, ispartyledger: false, amount: money(sale.cgst) },
    { ledgername: t.sgst.ledger, isdeemedpositive: false, ispartyledger: false, amount: money(sale.sgst) },
    ...(sale.tds ? [{ ledgername: t.tds.ledger, isdeemedpositive: false, ispartyledger: false, amount: money(-sale.tds) }] : []),
    ...(sale.rounding && t.rounding ? [{ ledgername: t.rounding, isdeemedpositive: false, ispartyledger: false, amount: money(sale.rounding) }] : []),
  ];
  const allinventoryentries = sale.rows.map((r) => ({
    stockitemname: r.item, isdeemedpositive: false,
    rate: `${money(r.rate)}/Nos`, amount: money(r.amount), actualqty: nos(r.qty), billedqty: nos(r.qty),
    batchallocations: [{ godownname: t.godown, batchname: t.batch, amount: money(r.amount), actualqty: nos(r.qty), billedqty: nos(r.qty) }],
    accountingallocations: [{ ledgername: t.salesLedger, isdeemedpositive: false, amount: money(r.amount) }],
  }));
  return {
    metadata: { type: 'Voucher', vchtype: t.voucherType, action: 'Create', objview: 'Invoice Voucher View' },
    date, effectivedate: date, referencedate: date, vouchertypename: t.voucherType, vouchernumber: number,
    persistedview: 'Invoice Voucher View', vchentrymode: 'Item Invoice', isinvoice: true, ...(optional ? { isoptional: true } : {}),
    reference: number, narration: '',
    partyname: t.party, partyledgername: t.party, partymailingname: t.mailingName,
    statename: t.placeOfSupply, placeofsupply: t.placeOfSupply, countryofresidence: 'India',
    gstregistrationtype: t.gstRegistrationType, partygstin: t.partyGstin,
    consigneemailingname: t.mailingName, consigneestatename: t.consigneeState, consigneegstin: t.consigneeGstin, consigneecountryname: 'India',
    ledgerentries, allinventoryentries,
  };
}

// --- sale only: the purchase is already in Tally --------------------------------------------------------------
const nameKey = (s) => String(s || '').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
const overlap = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };

// The sale's lines from the purchase voucher already in Tally: each of its items (Tally's own name, its quantity) takes the
// costing rate of the BOE line it was bought as. A purchase item belongs to the BOE line with the same USD price and enough
// quantity left; when several lines share that price (two $10 spare parts) the one whose description reads most like the item
// name wins. Returns { lines, problems }.
export function linesFromPurchase(purchaseItems, boeLines, rateOf) {
  const left = new Map(boeLines.map((l) => [l.key, l.qty]));
  const lines = [], problems = [];
  for (const p of purchaseItems) {
    const cands = boeLines.filter((l) => left.get(l.key) > 1e-9 && p.qty <= left.get(l.key) + 1e-9 && (!(p.price > 0) || Math.abs(l.price - p.price) < 0.01));
    if (!cands.length) { problems.push(`the purchase's item "${p.item}" (${p.qty} at ${p.price || '?'}) fits no BOE line`); continue; }
    const scored = cands.map((l) => ({ l, s: overlap(p.item, l.description) })).sort((a, b) => b.s - a.s);
    const best = scored[0];
    const rival = scored.find((x) => x !== best && x.s === best.s && rateOf.get(x.l.key)?.rate !== rateOf.get(best.l.key)?.rate);
    if (rival) { problems.push(`the purchase's item "${p.item}" could be BOE line ${best.l.invsno}/${best.l.itemsn} or ${rival.l.invsno}/${rival.l.itemsn} (same price, different value) — cannot tell which`); continue; }
    const c = rateOf.get(best.l.key);
    left.set(best.l.key, left.get(best.l.key) - p.qty);
    if (!c || !(c.rate > 0)) { problems.push(`BOE line ${best.l.invsno}/${best.l.itemsn} has no value in the portal's costing`); continue; }
    lines.push({ key: best.l.key, item: p.item, qty: p.qty, rate: c.rate });
  }
  for (const l of boeLines) if (left.get(l.key) > 1e-6) problems.push(`BOE line ${l.invsno}/${l.itemsn}: ${left.get(l.key)} of ${l.qty} are not on the purchase in Tally`);
  return { lines, problems };
}

// Sales to Headphone Zone dated on/after `fromIso` that already hold EVERY one of these items in exactly these quantities —
// the sale of this BOE has most likely been made (by hand, or by this app). A sale that merely contains some of the items
// (sold from older stock) does not match. Returns [{ number, date }].
export async function findSimilarSales(lines, fromIso, toIso) {
  const f = ymd8(fromIso), t = ymd8(toIso);
  const mine = (await salesWithParty(f, t)).filter((v) => BUYER.test(v.party) && !v.cancelled && v.date >= f);
  if (!mine.length || !lines.length) return [];
  const out = [];
  const numbers = mine.map((v) => v.number).slice(-200);
  for (const v of await readSalesVouchersBatch(numbers, f, t)) if (holdsAll(lines, v.items)) out.push({ number: v.voucherNumber, date: v.date });
  return out;
}

// Do these voucher items hold every one of the sale's items in exactly its quantity (names compared ignoring case/spacing)?
export function holdsAll(lines, voucherItems) {
  const sum = (list) => { const m = new Map(); for (const l of list) m.set(nameKey(l.item), round2((m.get(nameKey(l.item)) || 0) + l.qty)); return m; };
  const want = sum(lines), have = sum(voucherItems);
  return want.size > 0 && [...want].every(([k, q]) => have.get(k) === q);
}

// --- what the screen shows and the post uses ---------------------------------------------------------------
// `pr`: the Purchase Import result for this BOE (lines with their Tally items, and `existing`: the vouchers already in
// Tally that book it). Two modes: with the purchase not yet in Tally the sale's items are the screen's lines (`mode` unset);
// with the import purchase already in Tally ('sale-only') they are that purchase's own items. Either way Tally is checked
// for a sale with the same items first (`force` accepts it anyway). Never throws: whatever stops the sale is a problem.
export async function prepareSale(pr, { date, fromIso, toIso, force = false }) {
  const out = { ok: false, problems: [], warnings: [], date };
  try {
    const costing = await fetchBoeCosting(pr.boe.be_no);
    const rateOf = new Map(costing.rows.map((r) => [r.key, r]));
    let lines = [];
    const tp = (pr.existing || []).find((v) => v.type === IMPORT_VOUCHER_TYPE.FV && v.masterId);
    if (tp) {
      out.mode = 'sale-only';
      out.purchase = { number: tp.number, date: tp.date, optional: Boolean(tp.optional) };
      const w = await readPurchaseVoucher(tp.masterId, tp.date);
      if (!w) out.problems.push(`could not read purchase ${tp.number} from Tally`);
      else {
        const r = linesFromPurchase(w.items, pr.lines, rateOf);
        lines = r.lines; out.problems.push(...r.problems);
      }
    } else {
      for (const l of pr.lines) {
        const c = rateOf.get(l.key);
        if (!c) { out.problems.push(`line ${l.invsno}/${l.itemsn} is not in the portal's costing`); continue; }
        if (!(c.rate > 0)) out.problems.push(`line ${l.invsno}/${l.itemsn} has no value in the portal's costing`);
        for (const x of l.tally) if (x.item) lines.push({ key: l.key, item: x.item, qty: x.qty, rate: c.rate });
      }
    }
    out.costing = { pool: costing.pool, exchangeRate: costing.exchangeRate, total: costing.total };
    if (lines.length && !out.problems.length) {
      const since = tp?.date || ymd8(pr.boe.be_date);
      const similar = await findSimilarSales(lines, `${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6, 8)}`, toIso);
      if (similar.length) {
        out.existingSales = similar;
        const msg = `a sale to Headphone Zone with all these items and quantities is already in Tally: ${similar.map((s) => s.number).join(', ')}`;
        (force ? out.warnings : out.problems).push(force ? `${msg} — creating another one as you chose` : msg);
      }
    }
    const t = await readSaleTemplate(fromIso, toIso);
    if (t.problems) out.problems.push(...t.problems.map((p) => `the sale to Headphone Zone: ${p}`));
    if (t.template) {
      out.template = t.template;
      out.number = nextNumber(t.template.from, t.taken);
      if (!out.number) out.problems.push(`cannot work out the next number after "${t.template.from}"`);
      else if (t.taken.has(out.number)) out.problems.push(`sale number ${out.number} is already in Tally`);
      if (!t.template.tds) out.warnings.push(`the sale copied from ${t.template.from} has no TDS line — none is added`);
      if (lines.length && !out.problems.length) out.sale = computeSale(lines, t.template);
    }
    out.ok = !out.problems.length && Boolean(out.sale);
  } catch (err) {
    out.problems.push(`the sale to Headphone Zone: ${err.message}`);
  }
  return out;
}

// Read the posted sale back: the same lines and amounts as sent. Returns the differences (empty: it matches).
export function compareSale(voucher, back) {
  const diffs = [];
  const amt = (list, name) => round2(list.filter((l) => l.ledger === name).reduce((s, l) => s + l.amount, 0));
  for (const l of voucher.ledgerentries) {
    const want = round2(Number(l.amount)), got = amt(back.ledgers, l.ledgername);
    if (want !== got) diffs.push(`${l.ledgername}: sent ${want.toFixed(2)}, Tally has ${got.toFixed(2)}`);
  }
  const key = (i) => `${String(i.item).trim().toLowerCase()}|${i.qty}|${round2(i.amount)}`;
  const sent = voucher.allinventoryentries.map((e) => ({ item: e.stockitemname, qty: parseFloat(e.billedqty), amount: Number(e.amount) })).map(key).sort();
  const held = back.items.map(key).sort();
  if (JSON.stringify(sent) !== JSON.stringify(held)) diffs.push(`items: sent ${sent.length} line(s); Tally has ${held.length} (${held.join(', ') || 'none'})`);
  return diffs;
}
