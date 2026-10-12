// Credit Note (Goods Return) — the accounting rules.
//
// Ported from the Apps Script credit-note generator (E:\Data\Projects\Credit Note\apps-script\Code.gs,
// repo version with the multi-unit averaging fix), so a credit note made here has the same amounts as
// one the script would have made. Deliberate differences:
//   * items are matched by SKU (RMS stores it) instead of the script's fuzzy name match;
//   * the invoice is the shipping package that actually holds the returned SKU, not always package 1;
//   * per-unit values are averaged over every unit of that SKU in the package (the script took the
//     first N unused units), so returns of single units on different days still add up exactly;
//   * mixed GST slabs in one order each get their own sales/output ledgers (the script used the
//     first item's slab for the whole voucher);
//   * the party amount is the sum of the rows actually posted, so the voucher always balances.
// Pure functions: no Tally, no RMS. The data comes from RMS /api/credit-note-link/order.

export const VOUCHER_TYPE = 'Credit Note (Goods Return)';
export const GODOWN = 'Chennai Wh -Good';
export const REASON = '01-Sales Return';
const HOME_STATE = 'TN';
const SLABS = [5, 12, 18, 28];

export const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

// Output GST ledgers as named in the live company (read 2026-09-30); 12% and 28% do not exist there
// yet and keep the script's names, so posting is blocked until accounts create them.
export const GST_LEDGERS = {
  5: { cgst: 'Output CGST 2.50%', sgst: 'Output SGST 2.50%', igst: 'Output IGST @5%' },
  12: { cgst: 'Output CGST @6%', sgst: 'Output SGST @6%', igst: 'Output IGST @12%' },
  18: { cgst: 'Output CGST @9%', sgst: 'Output SGST @9%', igst: 'Output IGST @18%' },
  28: { cgst: 'Output CGST @14%', sgst: 'Output SGST @14%', igst: 'Output IGST @28%' },
};
export const COD_LEDGER = 'COD Charges';
export const salesLedger = (slab, interstate) => `${interstate ? 'Interstate' : 'Local'} GST${slab}.0%`;

// Same rule as the script: the nearest standard slab within 1 point, otherwise 18.
export function gstSlab(it) {
  const total = Math.round((Number(it.cgst_pct) || 0) + (Number(it.sgst_pct) || 0) + (Number(it.igst_pct) || 0));
  return SLABS.find((s) => Math.abs(total - s) <= 1) ?? 18;
}

const istDate = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : '');
const avg = (list, f) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0) / list.length;

/**
 * Work out one credit note.
 * @param {object} p
 * @param {Array<{rma_number:string, sku:string, item:string, qty:number}>} p.rows   RMS rows to credit
 * @param {object} p.uc   RMS's Unicommerce detail (getUnicommerceCreditNoteData)
 * @param {Record<string, number>} [p.creditedUnits]  units per SKU already on earlier credit notes of this order
 * @returns {{ ok:boolean, problems:string[], warnings:string[], note?:object }}
 */
export function computeCreditNote({ rows, uc, creditedUnits = {} }) {
  const problems = [], warnings = [];
  if (!uc) return { ok: false, problems: ['no Unicommerce data for this order'], warnings };
  if (!rows?.length) return { ok: false, problems: ['no items selected'], warnings };

  const interstate = String(uc.billing?.state_code || HOME_STATE).toUpperCase() !== HOME_STATE;
  const lines = [];
  let pkg = null;

  for (const r of rows) {
    const sku = String(r.sku || '').toLowerCase();
    const qty = Math.max(1, Number(r.qty) || 1);
    // Packages that hold this SKU; one credit note refers to one invoice.
    const pkgs = uc.packages.filter((p) => uc.items.some((i) => i.package_code === p.code && i.sku.toLowerCase() === sku));
    if (!pkgs.length) { problems.push(`${r.item}: SKU ${r.sku} is not on any invoice of this order in Unicommerce`); continue; }
    const chosen = pkg && pkgs.some((p) => p.code === pkg.code) ? pkg : pkgs[0];
    if (pkgs.length > 1) warnings.push(`${r.item}: SKU is on ${pkgs.length} invoices; using ${chosen.invoice_display_code || chosen.code}`);
    if (pkg && chosen.code !== pkg.code) { problems.push(`${r.item} is on a different invoice (${chosen.invoice_display_code}) from the other items (${pkg.invoice_display_code}) — credit it separately`); continue; }
    pkg = chosen;

    const units = uc.items.filter((i) => i.package_code === pkg.code && i.sku.toLowerCase() === sku);
    const already = Number(creditedUnits[sku] || 0);
    if (already + qty > units.length) {
      problems.push(`${r.item}: ${qty} unit(s) to credit, but ${units.length} sold and ${already} already credited`);
      continue;
    }
    const taxable = avg(units, (u) => u.selling_price_ex_tax_and_discount - u.discount);
    const rate = taxable > 0 ? taxable : avg(units, (u) => u.selling_price);
    const slab = gstSlab(units[0]);
    const codIncl = avg(units, (u) => u.cod_charges);
    lines.push({
      rma_number: r.rma_number, item: r.item, sku: r.sku, qty, slab,
      rate: round2(rate), amount: round2(round2(rate) * qty),
      cgst: round2(avg(units, (u) => u.cgst) * qty), sgst: round2(avg(units, (u) => u.sgst) * qty), igst: round2(avg(units, (u) => u.igst) * qty),
      cod: codIncl > 0 ? round2(codIncl / (1 + slab / 100)) * qty : 0,
    });
  }
  if (problems.length) return { ok: false, problems, warnings };

  // Tax rows per slab: IGST when interstate and IGST was charged, otherwise CGST + SGST (the script's rule).
  const taxRows = [];
  for (const slab of [...new Set(lines.map((l) => l.slab))]) {
    const ls = lines.filter((l) => l.slab === slab);
    const L = GST_LEDGERS[slab];
    const sum = (k) => round2(ls.reduce((s, l) => s + l[k], 0));
    if (interstate && sum('igst') > 0) taxRows.push({ ledger: L.igst, amount: sum('igst') });
    else {
      if (sum('cgst') > 0) taxRows.push({ ledger: L.cgst, amount: sum('cgst') });
      if (sum('sgst') > 0) taxRows.push({ ledger: L.sgst, amount: sum('sgst') });
    }
  }
  const cod = uc.cod ? round2(lines.reduce((s, l) => s + l.cod, 0)) : 0;
  const itemsTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const party = round2(itemsTotal + taxRows.reduce((s, t) => s + t.amount, 0) + cod);

  const gstin = uc.customer_gstin || '';
  const regular = Boolean(gstin);
  if (regular) warnings.push('B2B (customer has a GSTIN): generate the e-invoice for this credit note in Tally');

  return {
    ok: true, problems, warnings,
    note: {
      customer_name: uc.billing?.name || '',
      voucher_type: VOUCHER_TYPE,
      party_ledger: pkg.customer || uc.notification_email,
      invoice_no: pkg.invoice_display_code || pkg.invoice_code,
      invoice_date: istDate(pkg.invoice_date),
      interstate, cod_order: Boolean(uc.cod),
      gstin, gst_registration_type: regular ? 'Regular' : 'Unregistered/Consumer',
      nature_of_sales: regular ? 'Not Applicable' : 'B2C (Small)',
      billing: uc.billing, shipping: uc.shipping, place_of_supply: uc.billing?.state_name || '',
      lines: lines.map((l) => ({ ...l, ledger: salesLedger(l.slab, interstate), godown: GODOWN })),
      tax: taxRows, cod, items_total: itemsTotal, party_amount: party,
    },
  };
}

// --- Numbering --------------------------------------------------------------------------------------
// The first credit note of an order is numbered with the order number; a later return of other items
// gets order-1, order-2 … An issued credit note is never altered (it may already be on the GST portal).
// `taken` must hold the numbers of BOTH credit-note types (Goods Return and Return) plus any number
// this app has issued, so a number is never reused across types.
export function nextCreditNoteNumber(orderNo, taken) {
  const base = String(orderNo).trim();
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Numbers that belong to this order: the bare order number and order-N.
export function numbersOfOrder(orderNo, taken) {
  const base = String(orderNo).trim();
  const isSuffix = (rest) => rest.length > 0 && [...rest].every((c) => c >= '0' && c <= '9');
  return [...taken].filter((t) => t === base || (t.startsWith(`${base}-`) && isSuffix(t.slice(base.length + 1))));
}

// Units already credited per SKU, from the order's existing credit notes in Tally (item names) and the
// RMS rows of the order (item name -> SKU). Tally item names equal RMS product names.
export function creditedUnitsBySku(existingNotes, rmsRows) {
  const skuOf = new Map(rmsRows.map((r) => [String(r.item).trim().toLowerCase(), String(r.sku || '').toLowerCase()]));
  const out = {};
  for (const n of existingNotes) for (const it of n.items) {
    const sku = skuOf.get(String(it.item).trim().toLowerCase());
    if (sku) out[sku] = (out[sku] || 0) + (Number(it.qty) || 0);
  }
  return out;
}

// --- The Tally voucher ------------------------------------------------------------------------------
// JSON import shape, mirroring a real Goods Return credit note exported from the live company (field
// names from its XML: GSTNATUREOFRETURN, URDORIGINALSALEVALUE, Agst Ref bill on the order number …).
// Amounts: Cr positive, Dr negative, as in Tally's own export. Country is always India on both
// fields — missing it is what put 2,247 credit notes into GSTR-1 "country not specified".
const ymd = (s) => String(s || '').replace(/-/g, '');
const money = (x) => round2(x).toFixed(2);
const nos = (q) => ` ${Number(q).toFixed(1)} Nos`;

export function buildCreditNoteVoucher({ voucherNumber, date, orderNo, narration, note }) {
  const d = ymd(date);
  const b = note.billing || {}, s = note.shipping || b;
  const ledgerentries = [
    {
      ledgername: note.party_ledger, isdeemedpositive: false, ispartyledger: true, amount: money(note.party_amount),
      billallocations: [{ name: String(orderNo), billtype: 'Agst Ref', amount: money(note.party_amount) }],
    },
    ...(note.cod > 0 ? [{ ledgername: COD_LEDGER, isdeemedpositive: true, ispartyledger: false, amount: money(-note.cod) }] : []),
    ...note.tax.map((t) => ({ ledgername: t.ledger, isdeemedpositive: true, ispartyledger: false, amount: money(-t.amount) })),
  ];
  const allinventoryentries = note.lines.map((l) => ({
    stockitemname: l.item, isdeemedpositive: true,
    rate: `${money(l.rate)}/Nos`, amount: money(-l.amount), actualqty: nos(l.qty), billedqty: nos(l.qty),
    batchallocations: [{ godownname: GODOWN, batchname: 'Primary Batch', amount: money(-l.amount), actualqty: nos(l.qty), billedqty: nos(l.qty) }],
    accountingallocations: [{ ledgername: l.ledger, isdeemedpositive: true, amount: money(-l.amount) }],
  }));
  return {
    metadata: { type: 'Voucher', vchtype: VOUCHER_TYPE, action: 'Create', objview: 'Invoice Voucher View' },
    date: d, effectivedate: d, vouchertypename: VOUCHER_TYPE, vouchernumber: voucherNumber,
    persistedview: 'Invoice Voucher View', vchentrymode: 'Item Invoice', isinvoice: true,
    narration: narration || String(orderNo),
    reference: note.invoice_no, referencedate: ymd(note.invoice_date),
    partyname: note.party_ledger, partyledgername: note.party_ledger, partymailingname: note.customer_name || '',
    basicbuyeraddress: b.line ? [b.line] : [], address: b.line ? [b.line] : [],
    partypincode: b.pincode || '', statename: b.state_name || '', placeofsupply: note.place_of_supply || b.state_name || '',
    countryofresidence: 'India',
    gstregistrationtype: note.gst_registration_type, partygstin: note.gstin || '',
    consigneestatename: s.state_name || '', consigneepincode: s.pincode || '', consigneecountryname: 'India',
    gstnatureofreturn: REASON,
    urdoriginalsalevalue: note.nature_of_sales,
    ledgerentries, allinventoryentries,
  };
}
