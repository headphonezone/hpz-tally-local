// The BOE Costing Portal's costing of a BOE, ported from its frontend/src/lib/costing.ts (computeActual, no scenario).
// It is what the portal's costing sheet shows: per piece, the "+2% MARGIN" value, and TOTAL COST = qty x that.
//
//   declared INR   Fi = unit USD price x qty x exchange rate
//   share          si = Fi / sum(F)
//   expenses       the pool x si — freight + insurance + clearance + misc + supplier freight + bank charges +
//                  own bank charges + DO charges + exporter inland freight (IGST is NOT in the cost: it is creditable)
//   duty in cost   BCD (or the licence-foregone BCD when cash BCD is nil) + SWS
//   cost per piece (Fi + duty + pool x si) / qty
//   selling        cost per piece x (1 + margin%), margin 2
//
// Inputs come from the portal's rows exactly as it reads them: an operator-entered value in `boe_variable_fields`
// wins over the BOE's own, which wins over zero; clearance is 10,000 when none was entered (the sheet's yellow cell).
// BOE 4586997 on the sheet: Mojo 2 106,304.95 x 2 = 212,609.90 ... total 728,298.85 — see test/costing.mjs.

export const DEFAULT_CLEARANCE_INR = 10000;
export const MARGIN_PCT = 2;

// First value that is a number (not null/undefined), as the portal's num(); zero when none.
const num = (...c) => { for (const v of c) if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v); return 0; };
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export function expensePool(boe, v) {
  const parts = {
    freight: num(v?.freight_charges, boe.freight_inr),
    insurance: num(boe.insurance_inr),
    clearance: num(v?.clearing_charges, DEFAULT_CLEARANCE_INR),
    misc: num(boe.misc_charges_inr),
    supplierFreight: num(v?.supplier_freight),
    bankCharges: num(v?.bank_charges),
    ownBankCharges: num(v?.own_bank_charges),
    doCharges: num(v?.do_charges),
    exporterInlandFreight: num(v?.exporter_inland_freight),
  };
  return { ...parts, total: Object.values(parts).reduce((s, x) => s + x, 0) };
}

// `boe`: the boes row; `items`: its boe_items rows; `variable`: its boe_variable_fields row or null.
// Rows are keyed `${invsno}-${itemsn}` like Purchase Import's lines.
export function costBoe({ boe, items, variable = null }) {
  const rate = num(variable?.exchange_rate, boe.exchange_rate, 1);
  const pool = expensePool(boe, variable);
  const declared = items.map((i) => num(i.unit_price_usd) * num(i.qty) * rate);
  const totalDeclared = declared.reduce((s, x) => s + x, 0);
  const rows = items.map((i, k) => {
    const qty = num(i.qty);
    const cash = num(i.bcd);
    const duty = (cash > 0 ? cash : num(i.bcd_forgone)) + num(i.sws);
    const share = totalDeclared > 0 ? declared[k] / totalDeclared : 0;
    const landed = declared[k] + duty + pool.total * share;
    const costPerPiece = qty > 0 ? landed / qty : 0;
    const selling = costPerPiece * (1 + MARGIN_PCT / 100);
    return {
      key: `${i.invsno}-${i.itemsn}`, invsno: i.invsno, itemsn: i.itemsn, description: i.description, qty,
      costPerPiece: round2(costPerPiece), rate: round2(selling), amount: round2(qty * selling),
    };
  });
  return { exchangeRate: rate, pool, rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) };
}
