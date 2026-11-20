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

// DATES matter: Tally lets an Agst Ref settle only a bill that already exists on that date. A payment dated BEFORE its invoice
// therefore has to be the New Ref (the invoice, dated later, settles it); only a payment dated on or after the invoice is Agst Ref.
// (Found 2026-11-20: 51 Cashfree payments sent as Agst Ref for invoices dated after them came out as New Ref.)
//
// Sales rows (lib/tally.mjs billsInRange('Sales')) -> Map key -> { type: 'New Ref' | 'Agst Ref' | 'On Account', date: yyyymmdd }
export function indexInvoices(rows) {
  const out = new Map();
  for (const r of rows) {
    const b = r.bills?.[0];
    const name = (b?.name || r.ref || '').trim();
    if (!name) continue;
    const type = b?.name ? (b.type === 'New Ref' ? 'New Ref' : 'Agst Ref') : 'On Account';
    const k = keyOf(r.party, name);
    if (type === 'New Ref' || !out.has(k)) out.set(k, { type, date: String(r.date || '') });
  }
  return out;
}

// Journal rows (billsInRange('Journal')) -> Map key -> date (yyyymmdd) of the earliest journal that holds the bill as a New Ref
export function indexNewRefJournals(rows) {
  const out = new Map();
  for (const r of rows) for (const b of r.bills || []) if (b.name && b.type === 'New Ref') { const k = keyOf(r.party, b.name), d = String(r.date || ''); if (!out.has(k) || d < out.get(k)) out.set(k, d); }
  return out;
}

// invoice: the entry from indexInvoices (or undefined); journalYmd: the payment's date (yyyymmdd)
export const paymentBillType = (invoice, journalYmd) => (invoice?.type === 'New Ref' && (!invoice.date || !journalYmd || invoice.date <= journalYmd) ? 'Agst Ref' : 'New Ref');
// journalYmd: date of the payment that holds the bill (undefined: none); invoiceYmd: the invoice's date. The invoice settles the bill only
// when the payment is not dated after it — otherwise the invoice is the New Ref and the later payment settles it.
export const invoiceBillType = (journalYmd, invoiceYmd) => (journalYmd !== undefined && (!journalYmd || !invoiceYmd || journalYmd <= invoiceYmd) ? 'Agst Ref' : 'New Ref');
