// Equivalence test: the Apps Script credit-note generator (repo version of Code.gs, run as-is in a VM)
// and lib/creditnote.mjs must produce the same amounts for the same order.
//   node test/creditnote-vs-appsscript.mjs [path-to-Code.gs]
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { computeCreditNote, round2 } from '../lib/creditnote.mjs';

const CODE_GS = process.argv[2] || 'E:\\Data\\Projects\\Credit Note\\apps-script\\Code.gs';
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), ctx);   // only defines vars/functions; no Google calls at load

// RMS's getUnicommerceCreditNoteData() mapping, replicated for raw test orders.
const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const addr = (a) => a ? { name: a.name || '', line: [a.addressLine1, a.addressLine2, a.city].filter(Boolean).join(' ').trim(), city: a.city || '', state_code: a.state || '', state_name: a.stateName || a.state || '', pincode: a.pincode || '' } : null;
const toUc = (o) => ({
  sale_order_code: o.code, display_order_code: o.displayOrderCode || '', cod: !!o.cod, customer_gstin: String(o.customerGSTIN || '').trim(),
  notification_email: o.notificationEmail || '', billing: addr(o.billingAddress),
  shipping: addr((o.addresses || []).length >= 2 ? o.addresses[1] : o.billingAddress),
  packages: o.shippingPackages.map((p) => ({ code: p.code, invoice_display_code: p.invoiceDisplayCode || '', invoice_code: p.invoiceCode || '', invoice_date: p.invoiceDate ? new Date(p.invoiceDate).toISOString() : null, irn: p.irn || '', customer: p.customer || '', status: '' })),
  items: o.saleOrderItems.map((i) => ({ code: i.code, sku: i.itemSku, name: i.itemName, seller_sku: i.sellerSkuCode || '', package_code: i.shippingPackageCode, status: '',
    selling_price: n(i.sellingPrice), selling_price_ex_tax_and_discount: n(i.sellingPriceWithoutTaxesAndDiscount), discount: n(i.discount),
    cgst: n(i.totalCentralGst), sgst: n(i.totalStateGst), igst: n(i.totalIntegratedGst),
    cgst_pct: n(i.centralGstPercentage), sgst_pct: n(i.stateGstPercentage), igst_pct: n(i.integratedGstPercentage), cod_charges: n(i.cashOnDeliveryCharges) })),
});

// A sold unit. Unicommerce lists one line per unit.
const unit = (sku, name, pkg, { price, disc = 0, tax, pct = 18, inter, cod = 0 }) => ({
  code: `${sku}-${Math.random().toString(36).slice(2, 7)}`, itemSku: sku, itemName: name, sellerSkuCode: sku, shippingPackageCode: pkg,
  sellingPrice: price, sellingPriceWithoutTaxesAndDiscount: round2((price - cod) / (1 + pct / 100) + disc), discount: disc,
  totalCentralGst: inter ? 0 : tax / 2, totalStateGst: inter ? 0 : tax / 2, totalIntegratedGst: inter ? tax : 0,
  centralGstPercentage: inter ? 0 : pct / 2, stateGstPercentage: inter ? 0 : pct / 2, integratedGstPercentage: inter ? pct : 0,
  cashOnDeliveryCharges: cod,
});
const order = (state, cod, units) => ({
  code: 'SO1', displayOrderCode: '#1199999', cod, customerGSTIN: '', notificationEmail: 'buyer@example.com',
  billingAddress: { name: 'Buyer', addressLine1: '1 Street', city: 'City', state, stateName: state === 'TN' ? 'Tamil Nadu' : 'Karnataka', pincode: '600001' },
  addresses: [], shippingPackages: [{ code: 'P1', invoiceDisplayCode: 'HPZPL2627-1', invoiceCode: 'INV1', invoiceDate: Date.UTC(2026, 8, 20, 10), customer: 'buyer@example.com' }],
  saleOrderItems: units,
});

const cases = [
  { name: 'Tamil Nadu, prepaid, one 18% item', o: order('TN', false, [unit('KZ-CASTOR', 'KZ Castor', 'P1', { price: 1490, tax: 227.29 })]),
    rows: [{ sku: 'KZ-CASTOR', item: 'KZ Castor', qty: 1 }] },
  { name: 'Karnataka, COD, two SKUs, one with a free second unit (order 1059713 pattern)', o: order('KA', true, [
      unit('MOON-CHU', 'Moondrop Chu II', 'P1', { price: 2873.9, tax: 425.59, inter: true, cod: 99 }),
      unit('TRN-MT1', 'TRN MT1', 'P1', { price: 199, tax: 30.36, inter: true }),
      unit('TRN-MT1', 'TRN MT1', 'P1', { price: 0, tax: 0, inter: true }),
    ]), rows: [{ sku: 'MOON-CHU', item: 'Moondrop Chu II', qty: 1 }, { sku: 'TRN-MT1', item: 'TRN MT1', qty: 2 }] },
  { name: 'Tamil Nadu, COD, 3 units of one SKU with a discount', o: order('TN', true, [1, 2, 3].map(() => unit('FIIO-JD1', 'FiiO JD1', 'P1', { price: 1099, disc: 50, tax: 160.07, cod: 49 })) ),
    rows: [{ sku: 'FIIO-JD1', item: 'FiiO JD1', qty: 3 }] },
];

let failed = 0;
for (const c of cases) {
  // --- the Apps Script, exactly as it runs (fetchOrderData's extraction, then matchItems + buildValues)
  const pkg = c.o.shippingPackages[0];
  const saleItems = c.o.saleOrderItems.filter((i) => i.shippingPackageCode === pkg.code);
  const isInterstate = String(c.o.billingAddress.state || 'TN').toUpperCase() !== 'TN';
  const sheetRows = c.rows.map((r) => ({ 'Model Name': r.item, 'Quantity No': `Qty -${r.qty}` }));
  const mr = ctx.matchItems(sheetRows, saleItems, isInterstate);
  assert.equal(mr.unmatched.length, 0, `${c.name}: Apps Script could not match ${mr.unmatched}`);
  const codCharges = c.o.cod ? mr.matched.reduce((s, it) => s + (it.cod_charges || 0) * (it.quantity || 1), 0) : 0;
  const values = ctx.buildValues([{ order_no: '1199999', invoice_no: 'HPZPL2627-1', invoice_date: '20-Sep-2026', voucher_date: '01-10-2026',
    customer_email: 'buyer@example.com', cod_charges: codCharges, items: mr.matched, gst_reg_type: 'Unregistered/Consumer' }]);
  const head = values[0]; const col = (k) => head.indexOf(k);
  const body = values.slice(1);
  const script = {
    party: Number(body[0][col('Ledger Amount')]),
    items: body.filter((r) => r[col('Item Name')]).map((r) => Number(r[col('Item Amount')])).sort((a, b) => a - b),
    cod: Number(body.find((r) => r[col('Ledger Name')] === 'COD Charges')?.[col('Ledger Amount')] || 0),
    tax: body.filter((r) => /^Output /.test(r[col('Ledger Name')] || '')).map((r) => Number(r[col('Ledger Amount')])).sort((a, b) => a - b),
  };

  // --- the new module, on the same order as RMS would deliver it
  const res = computeCreditNote({ rows: c.rows.map((r, i) => ({ ...r, rma_number: `RMA-${i}` })), uc: toUc(c.o) });
  assert.ok(res.ok, `${c.name}: ${res.problems}`);
  const mine = {
    party: res.note.party_amount,
    items: res.note.lines.map((l) => l.amount).sort((a, b) => a - b),
    cod: res.note.cod,
    tax: res.note.tax.map((t) => t.amount).sort((a, b) => a - b),
  };
  const same = JSON.stringify(script) === JSON.stringify(mine);
  if (!same) failed++;
  console.log(`${same ? 'SAME' : 'DIFF'}  ${c.name}`);
  console.log(`      Apps Script: ${JSON.stringify(script)}`);
  console.log(`      new module:  ${JSON.stringify(mine)}`);
}
console.log(failed ? `\n${failed} case(s) differ` : '\nall cases match the Apps Script');
process.exit(failed ? 1 : 0);
