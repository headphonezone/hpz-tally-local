// Unicommerce Sales — the accounting rules.
//
// Shape and ledger naming verified against 518 REAL, already-posted Sales vouchers for 2026-10-10
// (Tally read via the gateway, cross-checked row-for-row against Unicommerce's own export). Confirmed,
// zero exceptions in that sample:
//   * voucher number = Unicommerce invoice number;
//   * party ledger = customer email, created on first sighting (see buildCustomerLedger);
//   * sales ledger = Unicommerce's own "Sales Ledger" column value, used verbatim — Unicommerce has
//     already worked out Local vs Interstate and the rate, no need to recompute it;
//   * tax ledgers = "Output <TAX> @<rate>%", rate taken from Unicommerce's own rate columns;
//   * COD Charges line is added only when Payment Method = COD (confirmed 114/518 COD, 404/518
//     PREPAID, 100% correlation with Unicommerce's own COD-charge column being nonzero);
//   * a multi-item order is ONE voucher with multiple inventory lines, not one voucher per line.
// Only 18% GST is in live use as of 2026-10 (per the business); other rates are not blocked, but have
// not been seen in real data, so treat any other rate as new territory — the ledger-existence check
// in the server will catch a missing ledger before anything is posted.
//
// Any OTHER nonzero charge/discount column (Shipping Charges, Service tax, Discount, …) also becomes
// its own ledger line, named exactly as Unicommerce gives it — never silently dropped, because a
// dropped nonzero amount is a voucher that doesn't balance to the real sale.

import { num } from './uc.mjs';

export const VOUCHER_TYPE = 'Sales';
export const GODOWN = 'Home Location'; // as seen on every real Oct-10 voucher's inventory batch
export const COD_LEDGER = 'COD Charges';

export const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

// "CGST9.0%" -> "Output CGST @9%" ; "IGST18.0%" -> "Output IGST @18%". Matches the live ledger names
// exactly (no ".0" in the tax ledger name, unlike the sales ledger which does carry ".0%").
function taxLedgerName(kind, rateLabel) {
  const m = String(rateLabel || '').match(/[\d.]+/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  const display = Number.isInteger(n) ? String(n) : String(n);
  return `Output ${kind} @${display}%`;
}

// Extra charge/discount columns beyond COD, each with its own amount + ledger-name column in the
// export. Any nonzero one becomes its own ledger line, named exactly as Unicommerce gives it.
const EXTRA_CHARGE_COLUMNS = [
  ['Other charges', 'Other charges Ledger'],
  ['Other charges1', 'Other charges Ledger1'],
  ['Other charges2', 'Other charges Ledger2'],
  ['Service tax', 'ST Ledger'],
];

/**
 * Work out one Sales voucher from a grouped Unicommerce order (see uc.mjs groupOrders).
 * Pure function: no Tally, no network.
 * @returns {{ ok:boolean, problems:string[], warnings:string[], note?:object }}
 */
export function computeSalesOrder(order) {
  const problems = [], warnings = [];
  if (!order.customerEmail) problems.push('no customer email on this order — cannot set the party ledger');
  if (!order.rows?.length) problems.push('no item rows on this order');
  if (problems.length) return { ok: false, problems, warnings };

  const lines = [];
  for (const r of order.rows) {
    const item = r['Product Name'];
    const qty = num(r['Qty']) || 1;
    const rate = num(r['Unit Price']);
    const amount = round2(num(r['Sales']));
    const salesLedger = r['Sales Ledger'];
    if (!item) { problems.push('a row on this order has no Product Name'); continue; }
    if (!salesLedger) { problems.push(`${item}: no Sales Ledger given by Unicommerce`); continue; }
    lines.push({ item, qty, rate, amount, ledger: salesLedger, hsn: r['HSN Code'] || '' });
  }
  if (problems.length) return { ok: false, problems, warnings };

  // Tax: sum CGST/SGST/IGST/UTGST/CESS per row, group by the ledger name the rate implies.
  const taxTotals = new Map(); // ledger -> amount
  const addTax = (kind, amtCol, rateCol) => {
    for (const r of order.rows) {
      const amt = round2(num(r[amtCol]));
      if (!amt) continue;
      const ledger = taxLedgerName(kind, r[rateCol]);
      if (!ledger) { problems.push(`${r['Product Name']}: ${kind} amount ${amt} but no readable rate in "${r[rateCol]}"`); continue; }
      taxTotals.set(ledger, round2((taxTotals.get(ledger) || 0) + amt));
    }
  };
  addTax('CGST', 'CGST', 'CGST Rate');
  addTax('SGST', 'SGST', 'SGST Rate');
  addTax('IGST', 'IGST', 'IGST Rate');
  addTax('UTGST', 'UTGST', 'UTGST Rate');
  addTax('CESS', 'CESS', 'CESS Rate');
  const taxRows = [...taxTotals.entries()].map(([ledger, amount]) => ({ ledger, amount }));

  // COD and any other nonzero charge/discount column — each its own ledger line, Unicommerce's naming.
  const extraRows = [];
  const isCod = String(order.paymentMethod).toUpperCase() === 'COD';
  for (const r of order.rows) {
    for (const [amtCol, ledCol] of EXTRA_CHARGE_COLUMNS) {
      const amt = round2(num(r[amtCol]));
      if (!amt) continue;
      const ledger = r[ledCol];
      if (!ledger) { problems.push(`${r['Product Name']}: ${amtCol} = ${amt} but no ledger name given (${ledCol} is blank)`); continue; }
      if (ledger === COD_LEDGER && !isCod) { problems.push(`${r['Product Name']}: COD Charges column is nonzero but Payment Method is "${order.paymentMethod}", not COD`); continue; }
      extraRows.push({ ledger, amount: amt });
    }
    // Discount Amount/Discount Ledger are deliberately NOT posted. Checked against 8,343 real, already
    // posted Sales vouchers (Oct 1-10): Total always equals Sales + tax (+ COD when applicable), with
    // Discount Amount completely absent — confirmed on rows where it exceeded the item's own price.
    // It is Unicommerce-side informational data (e.g. a marketplace-funded discount), not money this
    // voucher needs to account for. Posting it would make the voucher disagree with how these are
    // actually entered, not agree with it.
  }
  if (isCod && !extraRows.some((x) => x.ledger === COD_LEDGER)) warnings.push('Payment Method is COD but no COD Charges amount was found on this order');
  if (problems.length) return { ok: false, problems, warnings };

  // Merge same-named extra-charge lines (e.g. two rows both charging COD on a multi-item order).
  const extraByLedger = new Map();
  for (const x of extraRows) extraByLedger.set(x.ledger, round2((extraByLedger.get(x.ledger) || 0) + x.amount));
  const chargeRows = [...extraByLedger.entries()].map(([ledger, amount]) => ({ ledger, amount }));

  const itemsTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const taxTotal = round2(taxRows.reduce((s, t) => s + t.amount, 0));
  const chargeTotal = round2(chargeRows.reduce((s, c) => s + c.amount, 0));
  const partyAmount = round2(itemsTotal + taxTotal + chargeTotal);

  // Safety net: never post a voucher whose computed total silently disagrees with Unicommerce's own
  // per-line Total column — a mismatch means a column we don't yet handle moved money.
  const reportedTotal = round2(order.rows.reduce((s, r) => s + num(r['Total']), 0));
  if (Math.abs(partyAmount - reportedTotal) > 0.02) {
    problems.push(`computed total ${partyAmount} does not match Unicommerce's own Total ${reportedTotal} — a charge/discount column is not accounted for`);
    return { ok: false, problems, warnings };
  }

  return {
    ok: true, problems, warnings,
    note: {
      customer_email: order.customerEmail, customer_name: order.customerName, customer_mobile: order.customerMobile,
      billing_state: order.billingState, billing_address: order.billingAddress, billing_pincode: order.billingPincode,
      // shippingAddress already carries its own billing-fallback from uc.mjs's addressLines() — not
      // repeated here with `||`, since an empty array is truthy in JS and would have defeated it.
      shipping_state: order.shippingState || order.billingState, shipping_address: order.shippingAddress,
      shipping_pincode: order.shippingPincode || order.billingPincode,
      awb_number: order.awbNumber || '', shipping_provider: order.shippingProviderName || '',
      irn: order.irn || '', irn_ack_no: order.irnAckNo || '',
      customer_gstin: order.customerGSTIN, gst_registration_type: order.gstRegistrationType || 'Unregistered/Consumer',
      sale_order_number: String(order.saleOrderNumber || '').replace(/^#/, ''),
      lines, tax: taxRows, charges: chargeRows,
      items_total: itemsTotal, tax_total: taxTotal, charge_total: chargeTotal, party_amount: partyAmount,
    },
  };
}

// --- Customer ledger -----------------------------------------------------------------------------
// Field names come from a real, manually-created customer ledger read back from Tally as XML (created
// 2026-10-10 by a person — there was no automated ledger creation before this). The JSON tag names
// below are this codebase's usual lowercase convention applied to those same XML tags
// (LEDGSTREGDETAILS.LIST -> ledgstregdetails, etc.) — NOT yet proven the way the voucher shapes are.
// Test on a disposable company: create one ledger, then read it back with existingLedgers and ideally
// a full XML dump (see xml-integration.md in the TDL skill) before trusting this on production.

export function buildCustomerLedger({ email, name, mobile, state, addressLines, gstin, gstRegistrationType, dateYmd }) {
  return {
    metadata: { type: 'Ledger', action: 'Create' },
    name: email,
    parent: 'Sundry Debtors',
    ledgermobile: mobile || '',
    ledgstregdetails: [{
      applicablefrom: dateYmd,
      gstregistrationtype: gstRegistrationType || 'Unregistered/Consumer',
      state: state || '',
      placeofsupply: state || '',
      gstin: gstin || '',
    }],
    ledmailingdetails: [{
      applicablefrom: dateYmd,
      mailingname: name || email,
      address: addressLines || [],
      state: state || '',
      country: 'India',
    }],
  };
}


// --- The Tally voucher -----------------------------------------------------------------------------
// JSON import shape, mirroring a real Sales voucher exported from the live company (field names from
// its XML: VOUCHERNUMBER, PARTYLEDGERNAME, ALLINVENTORYENTRIES.LIST with nested ACCOUNTINGALLOCATIONS,
// ALLLEDGERENTRIES.LIST). Same sign convention as Credit Note: Cr positive, Dr negative, isdeemedpositive
// explicit on every single line — Tally does not infer the side from the array name.
const money = (x) => round2(x).toFixed(2);
const nos = (q) => ` ${Number(q).toFixed(1)} Nos`;

export function buildSalesVoucher({ voucherNumber, date, note }) {
  // Confirmed literal value Tally/Unicommerce both use for a GST-registered party — "Regular", not
  // "Registered" (seen as the company's own CMPGSTREGISTRATIONTYPE on a real voucher).
  const isRegistered = note.gst_registration_type === 'Regular';
  const ledgerentries = [
    { ledgername: note.customer_email, isdeemedpositive: true, ispartyledger: true, amount: money(-note.party_amount) },
    ...note.tax.map((t) => ({ ledgername: t.ledger, isdeemedpositive: false, ispartyledger: false, amount: money(t.amount) })),
    ...note.charges.map((c) => ({ ledgername: c.ledger, isdeemedpositive: false, ispartyledger: false, amount: money(c.amount) })),
  ];
  const allinventoryentries = note.lines.map((l) => ({
    stockitemname: l.item, isdeemedpositive: false,
    rate: `${money(l.rate)}/Nos`, amount: money(l.amount), actualqty: nos(l.qty), billedqty: nos(l.qty),
    batchallocations: [{ godownname: GODOWN, batchname: 'Primary Batch', amount: money(l.amount), actualqty: nos(l.qty), billedqty: nos(l.qty) }],
    accountingallocations: [{ ledgername: l.ledger, isdeemedpositive: false, amount: money(l.amount) }],
  }));
  return {
    metadata: { type: 'Voucher', vchtype: VOUCHER_TYPE, action: 'Create', objview: 'Invoice Voucher View' },
    date, effectivedate: date, vouchertypename: VOUCHER_TYPE, vouchernumber: voucherNumber,
    persistedview: 'Invoice Voucher View', vchentrymode: 'Item Invoice', isinvoice: true,
    narration: date.replace(/(\d{4})(\d{2})(\d{2})/, '$3.$2.$1').replace(/^0/, ''),
    reference: note.sale_order_number,
    // Buyer (Bill To) and Consignee (Ship To) addresses — proven 2026-10-16 against a real,
    // human-entered voucher (HPZPL2627-06252, Gujarat buyer / Maharashtra consignee, both GSTINs
    // differ) by reading its full field dump: the plain `address` tag holds the BUYER's address
    // (matched the Gujarat state/pincode), while `basicbuyeraddress` — despite its name — holds the
    // CONSIGNEE's address (matched the Maharashtra state/pincode). `consigneeaddress` does not exist
    // as an importable field; confirmed absent on every voucher tried, including via raw XML alter.
    partyname: note.customer_email, partyledgername: note.customer_email, partymailingname: note.customer_name || '',
    address: note.billing_address || [],
    statename: note.billing_state || '', placeofsupply: note.billing_state || '', partypincode: note.billing_pincode || '',
    countryofresidence: 'India',
    gstregistrationtype: note.gst_registration_type, partygstin: note.customer_gstin || '',
    consigneemailingname: note.customer_name || '', basicbuyeraddress: note.shipping_address || [],
    consigneestatename: note.shipping_state || note.billing_state || '', consigneepincode: note.shipping_pincode || note.billing_pincode || '',
    consigneecountryname: 'India',
    // Dispatch Details. basicshipdocumentno / basicshippedby are inferred, not proven: on a real
    // voucher (HPZPL2627-181597, read 2026-10-15) every OTHER dispatch field had its own clearly-named
    // tag (CARRIERNAME, BILLOFLADINGNO, GOODSVEHICLENUMBER, DISPATCHDATE) and was empty; these two were
    // the only unclaimed ones left matching "Dispatch Doc No." and "Dispatched through". Confirm by
    // reading a posted voucher back and checking these two fields actually landed.
    basicshipdocumentno: note.awb_number || '', basicshippedby: note.shipping_provider || '',
    // e-Invoice details — only for GST-registered parties (e-invoicing is a B2B/registered concept;
    // per instruction, never populated for Unregistered/Consumer regardless of what the export shows).
    // irn/irnackno are proven field names (seen as IRN/IRNACKNO, empty, on the same real voucher used
    // above). irnackdate is set to the sale date itself per instruction, not Tally's own ack-date
    // meaning — also unproven as a JSON tag, same caveat as the dispatch fields above. No separate
    // "Provide e-Invoice details: Yes/No" field was found anywhere in that voucher's full dump — most
    // likely a pure UI gate shown once IRN data is present, not a stored field of its own.
    ...(isRegistered && (note.irn || note.irn_ack_no)
      ? { irn: note.irn || '', irnackno: note.irn_ack_no || '', irnackdate: date }
      : {}),
    ledgerentries, allinventoryentries,
  };
}
