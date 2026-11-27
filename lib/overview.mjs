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

// Rows per day ('yyyy-mm-dd') from `from` to `to`, every day present (the last week's missing e-Way Bills / e-Invoices).
export function countByDay(rows, dateOf, from, to) {
  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const by = new Map(days.map((d) => [d, 0]));
  for (const r of rows) { const d = String(dateOf(r) || '').slice(0, 10); if (by.has(d)) by.set(d, by.get(d) + 1); }
  return [...by].map(([date, count]) => ({ date, count }));
}

// The month ('yyyy-mm') of a document row's voucher_date ('yyyy-mm-dd'), for the e-Way Bill / e-Invoice "missing by month".
export function countByMonth(rows, dateOf, from, to) {
  const by = new Map(monthsBetween(from, to).map((m) => [m, 0]));
  for (const r of rows) { const d = String(dateOf(r) || '').slice(0, 7); if (by.has(d)) by.set(d, by.get(d) + 1); }
  return [...by].map(([month, count]) => ({ month, count }));
}

// --- The printable report (PDF) ---------------------------------------------------------------------------------------
// One self-contained HTML page (inline styles, A4) that dispatchmail.buildPdf prints with headless Edge/Chrome. It mirrors the
// page on the Generate Report tab. It must start with a <div style="font-family:…> — buildPdf marks that div as the sheet.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n) => (n == null || n === '' ? '–' : Number(n).toLocaleString('en-IN'));
const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : iso || ''; };
const ymdText = (d) => (/^\d{8}$/.test(d || '') ? dmy(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`) : d || '');
const TD = 'padding:4px 8px;border-bottom:1px solid #e6e8ee;font-size:12px';
const RED = '#c0392b', GREEN = '#1e8449';
const table = (head, rows) => `<table style="border-collapse:collapse;width:100%;margin:6px 0 10px">`
  + (head ? `<thead><tr>${head.map((h, i) => `<th style="${TD};text-align:${i ? 'right' : 'left'};background:#eef1f7;font-weight:600">${esc(h)}</th>`).join('')}</tr></thead>` : '')
  + `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${TD};text-align:${i ? 'right' : 'left'}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const h2 = (t) => `<h2 style="font-size:15px;margin:18px 0 4px;color:#1d2b4f;border-bottom:2px solid #c9d3ea;padding-bottom:3px">${t}</h2>`;
const bad = (n, text) => `<b style="color:${n ? RED : GREEN}">${text ?? num(n)}</b>`;
const failed = (R, key) => (R.errors?.[key] ? `<p style="color:${RED};font-size:11px">Could not be read: ${esc(R.errors[key])}</p>` : '');

// What needs attention, and ONLY that: a section with nothing to do is left out. { lines: [{ section (the heading), label, n }], notes: [text] }.
// lines: what is not posted / missing / overdue (count > 0). notes: a check that could not be read or finished — silence there would look like "all fine".
export function attention(R) {
  const lines = [], notes = [];
  const add = (section, label, n) => { if (Number(n) > 0) lines.push({ section, label, n: Number(n) }); };
  add('E-Way Bill', 'Overdue and not closed', R.ewb?.overdue);
  add('E-Invoice', 'Overdue and not closed', R.einv?.overdue);
  add('Missing Sales', 'Unicommerce orders not in Tally', R.sales?.missing);
  add('Missing Invoice Numbers', 'Invoice numbers missing', R.invoices?.counts?.missing);
  add('Stock Journal', 'Not posted in Tally', R.stock?.pending);
  add('Payment Gateway', 'Journals not posted in Tally', R.gatewayPending?.missing);
  const label = { gst: 'e-Way Bill / e-Invoice', invoiceRead: 'the voucher numbers', invoices: 'missing invoice numbers', sales: 'missing sales', stock: 'Stock Journals' };
  for (const [k, v] of Object.entries(R.errors || {})) notes.push('Could not read ' + (label[k] || k) + ': ' + v);
  for (const k of ['ewb', 'einv']) for (const w of R[k]?.warnings || []) notes.push(w);
  if (R.sales?.errors?.length) notes.push('Missing sales is incomplete — Unicommerce failed for: ' + R.sales.errors.map((e) => e.range + ' (' + e.message + ')').join('; '));
  if (R.invoices?.note) notes.push(R.invoices.note);
  if (R.stock && !R.stock.checked && R.stock.note) notes.push('Stock Journals could not be checked against Tally: ' + R.stock.note);
  return { lines, notes };
}

export function reportHtml(R) {
  const A = attention(R);
  let h = "<div style=\"font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#22262e;max-width:860px;margin:0 auto;padding:20px\">";
  h += '<h1 style="font-size:20px;margin:0 0 2px;color:#1d2b4f">Report</h1><p style="margin:0 0 10px;font-size:12px;color:#555">' + esc(R.company) + ' · ' + dmy(R.from) + ' to ' + dmy(R.builtAt.slice(0, 10)) + ' · generated ' + esc(new Date(R.builtAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })) + ' IST</p>';
  for (const l of A.lines) h += h2(esc(l.section)) + table(null, [[esc(l.label), bad(l.n)]]);
  if (!A.lines.length && !A.notes.length) h += '<p style="font-size:14px;color:' + GREEN + '"><b>Nothing needs attention.</b></p>';
  for (const n of A.notes) h += '<p style="color:' + RED + ';font-size:12px;margin:4px 0">' + esc(n) + '</p>';
  return h + '</div>';
}
