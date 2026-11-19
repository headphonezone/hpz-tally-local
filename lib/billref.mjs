// New Ref / Agst Ref for a payment and its invoice, so the two never both open the same bill.
//
// A bill is born once (New Ref) and settled once (Agst Ref). Whichever of the payment journal and the sales invoice
// is booked FIRST creates it; the other settles it:
//   invoice already in Tally holding the bill as New Ref -> the payment is Agst Ref (settles it)
//   invoice already in Tally settling the bill (Agst Ref) -> the payment is the New Ref the invoice settles
//   no invoice yet, or an On Account invoice              -> the payment is the New Ref (Tally would turn an Agst Ref into one anyway)
//   a payment journal already holds the bill as New Ref    -> the invoice is Agst Ref (settles it)
//   otherwise                                              -> the invoice is New Ref
// Measured on Tally 2026-11-19: 7,684 of 29,471 Razorpay journals were New Ref; 3,931 of them paired with an Agst Ref
// invoice (nil outstanding), 2,878 faced an On Account invoice and stayed open, 872 had no invoice.

export const keyOf = (party, name) => `${String(party || '').trim().toLowerCase()}|${String(name || '').trim()}`;

// Sales rows (lib/tally.mjs billsInRange('Sales')) -> Map key -> 'New Ref' | 'Agst Ref' | 'On Account'
export function indexInvoices(rows) {
  const out = new Map();
  for (const r of rows) {
    const b = r.bills?.[0];
    const name = (b?.name || r.ref || '').trim();
    if (!name) continue;
    const type = b?.name ? (b.type === 'New Ref' ? 'New Ref' : 'Agst Ref') : 'On Account';
    const k = keyOf(r.party, name);
    if (type === 'New Ref' || !out.has(k)) out.set(k, type);
  }
  return out;
}

// Journal rows (billsInRange('Journal')) -> Set of keys whose bill a journal holds as an open New Ref credit
export function indexNewRefJournals(rows) {
  const out = new Set();
  for (const r of rows) for (const b of r.bills || []) if (b.name && b.type === 'New Ref') out.add(keyOf(r.party, b.name));
  return out;
}

export const paymentBillType = (invoiceState) => (invoiceState === 'New Ref' ? 'Agst Ref' : 'New Ref');
export const invoiceBillType = (journalHoldsNewRef) => (journalHoldsNewRef ? 'Agst Ref' : 'New Ref');
