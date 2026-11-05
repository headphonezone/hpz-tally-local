// Generate Report tab: the pure parts (dates, month tallies, "last date done"). The reading of Tally, Unicommerce and
// the GST data is in server.mjs (rpBuild); everything here is plain functions so it can be tested without any of them.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The financial year that contains `today` (ISO), up to today: { from: '2026-04-01', to: today }.
export function fyBounds(today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7);
  return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today };
}

export const monthLabel = (ym) => `${MON[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;   // '2026-04' -> 'Apr 2026'

// Every month from the one of `from` to the one of `to`, as 'yyyy-mm'.
export function monthsBetween(from, to) {
  const out = [];
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const ey = +to.slice(0, 4), em = +to.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

// Unicommerce's Tally GST export takes at most about three months: cut [from, to] at calendar quarters (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar).
export function quarterChunks(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const y = +cur.slice(0, 4), m = +cur.slice(5, 7);
    const qEndMonth = Math.ceil(m / 3) * 3;                       // 3, 6, 9, 12
    const qEnd = new Date(Date.UTC(y, qEndMonth, 0)).toISOString().slice(0, 10);   // last day of that month
    const end = qEnd < to ? qEnd : to;
    out.push([cur, end]);
    cur = new Date(Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10) + 1)).toISOString().slice(0, 10);
  }
  return out;
}

// An order's date 'DD-MM-YYYY' -> 'yyyy-mm' (null when it is not a date).
export function monthOfOrder(ddmmyyyy) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(ddmmyyyy || '').trim());
  return m ? `${m[3]}-${m[2]}` : null;
}

// Unicommerce orders per month, and how many of them Tally does not have. `isTaken(invoice)` says whether the invoice is in Tally
// (cancelled ones count as in Tally: their number is used). `keep(order)` drops the orders of the other office. Months come
// back in order, including months with no orders.
export function missingSalesByMonth(orders, { isTaken, keep = () => true, from, to }) {
  const by = new Map(monthsBetween(from, to).map((m) => [m, { month: m, orders: 0, missing: 0 }]));
  let undated = 0;
  for (const o of orders) {
    if (!keep(o)) continue;
    const m = monthOfOrder(o.date);
    const row = m && by.get(m);
    if (!row) { undated++; continue; }
    row.orders++;
    if (!isTaken(o.invoice)) row.missing++;
  }
  return { months: [...by.values()], undated };
}

// Journals (from journalsInRange with lines) -> the latest voucher date per group. `groups`: { name: [ledger names] }; a journal
// belongs to every group one of whose ledgers it touches. Cancelled ones are ignored; optional ones count but are tallied apart.
// -> { name: { date: 'yyyymmdd', number, optional: bool, count } | null }
export function latestJournalDates(journals, groups) {
  const out = {};
  for (const [name, ledgers] of Object.entries(groups)) {
    const want = new Set(ledgers.map((l) => l.toLowerCase()));
    let best = null, count = 0;
    for (const j of journals) {
      if (j.cancelled || !(j.lines || []).some((l) => want.has(String(l.ledger).toLowerCase()))) continue;
      count++;
      if (!best || j.date > best.date) best = { date: j.date, number: j.no, optional: j.optional };
    }
    out[name] = best && { ...best, count };
  }
  return out;
}

// The month ('yyyy-mm') of a document row's voucher_date ('yyyy-mm-dd'), for the e-Way Bill / e-Invoice "missing by month".
export function countByMonth(rows, dateOf, from, to) {
  const by = new Map(monthsBetween(from, to).map((m) => [m, 0]));
  for (const r of rows) { const d = String(dateOf(r) || '').slice(0, 7); if (by.has(d)) by.set(d, by.get(d) + 1); }
  return [...by].map(([month, count]) => ({ month, count }));
}
