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

function docSection(R, kind, title) {
  const d = R[kind];
  if (!d) return `${h2(title)}${failed(R, 'gst') || '<p style="font-size:12px;color:#777">Not read.</p>'}`;
  const y = d.yesterday, w = d.week, c = y.counts;
  const rows = [['Documents', num(c.all)], ['Open', num(c.open)], ['Overdue', bad(c.overdue)], ['Closed', num(c.closed)], ['Returned', num(c.returned)], ['Cancelled', num(c.cancelled)],
    ['Missing on yesterday\'s invoices', bad(y.missing.missing)]];
  if (kind === 'ewb' && y.portal) {
    const p = y.portal;
    if (p.checked) rows.push(['e-Way Bills on the GST portal', num(p.bills)], ['…of which not in Tally', bad(p.notInTally)], ['Paid GSP calls this check', num(p.calls)]);
    else rows.push(['GST portal', esc(p.error ? `not checked: ${p.error}` : R.test ? 'not checked (test mode — no token used)' : 'not checked')]);
  }
  const byDay = (w.byDay || []).filter((x) => x.count);
  return `${h2(`${title} — yesterday (${dmy(y.date)})`)}${table(null, rows)}`
    + (kind === 'ewb' && y.portal?.notInTallyList?.length ? `<p style="font-size:11px;color:#555">Not in Tally: ${y.portal.notInTallyList.map(esc).join(', ')}</p>` : '')
    + `<p style="font-size:12px;margin:6px 0 2px"><b>Missing ${title}, last 7 days (${dmy(w.from)} – ${dmy(w.to)}), checked in Tally only: ${bad(w.missing)}</b></p>`
    + (byDay.length ? `<p style="font-size:11px;color:#555">By day: ${byDay.map((x) => `${dmy(x.date)} <b>${x.count}</b>`).join(' · ')}</p>` : '');
}

export function reportHtml(R) {
  const L = R.lastDates, s = R.sales, inv = R.invoices, st = R.stock, gp = R.gatewayPending;
  const last = (list) => table(['', 'Last journal', 'Voucher'], list.map((x) => [esc(x.name), x.last ? `<b>${ymdText(x.last.date)}</b>` : `none in ${L.searchedDays} days`,
    x.last ? esc(x.last.number || '') + (x.last.optional ? ' (Optional)' : '') : '']));
  let h = `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#22262e;max-width:860px;margin:0 auto;padding:20px">`;
  h += `<h1 style="font-size:20px;margin:0 0 2px;color:#1d2b4f">Report</h1><p style="margin:0 0 6px;font-size:12px;color:#555">${esc(R.company)} · ${dmy(R.from)} to ${dmy(R.builtAt.slice(0, 10))} · generated ${esc(new Date(R.builtAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }))} IST${R.test ? ' · TEST (the GST portal was not used)' : ''}</p>`;
  h += table(['Summary', 'Count'], [
    ['Missing e-Way Bill (last 7 days)', bad(R.ewb?.week.missing)], ['Missing e-Invoice (last 7 days)', bad(R.einv?.week.missing)],
    ['Missing sales (Unicommerce orders not in Tally)', bad(s?.missing)], ['Missing invoice numbers', bad(inv?.counts.missing)],
    ['Pending Stock Journals (RMS)', bad(st?.pending)], ['Pending Payment Gateway journals', bad(gp?.missing)]]);
  h += docSection(R, 'ewb', 'e-Way Bill') + docSection(R, 'einv', 'e-Invoice');

  h += h2('Missing sales — Unicommerce orders not in Tally, month-wise');
  if (s) {
    h += table(['Month', 'Orders in Unicommerce', 'Not in Tally'], [...s.months.map((m) => [monthLabel(m.month), num(m.orders), bad(m.missing)]), ['<b>Total</b>', `<b>${num(s.orders)}</b>`, bad(s.missing)]]);
    for (const e of s.errors || []) h += `<p style="color:${RED};font-size:11px">Unicommerce ${esc(e.range)}: ${esc(e.message)} — that period is not counted.</p>`;
  }
  h += failed(R, 'sales');

  h += h2('Missing invoice numbers');
  if (inv) {
    const byMonth = new Map(); for (const x of inv.list) byMonth.set(x.month || '?', (byMonth.get(x.month || '?') || 0) + 1);
    h += `<p style="font-size:12px;margin:2px 0">${esc(inv.type)}, series ${esc(inv.series === '*' ? 'all' : inv.series)} · ${num(inv.scanned)} vouchers scanned — ${bad(inv.counts.missing)} truly missing · ${num(inv.counts.tally)} cancelled in Tally · ${num(inv.counts.uc)} cancelled in Unicommerce</p>`;
    if (byMonth.size) h += `<p style="font-size:11px;color:#555">By month: ${[...byMonth].map(([m, n]) => `${esc(m)} <b>${n}</b>`).join(' · ')}</p>`;
    if (inv.list.length) h += `<p style="font-size:11px;line-height:1.7;word-break:break-word">${inv.list.map((x) => `<code>${esc(x.id)}</code>`).join(' · ')}</p>`;
    if (inv.listTruncated) h += '<p style="font-size:11px;color:#777">The list is cut at 5,000 numbers.</p>';
  }
  h += failed(R, 'invoices') + failed(R, 'invoiceRead');

  h += h2('Pending JV import');
  h += table(null, [
    ['Stock Journals from RMS (Movement of Stock) not yet in Tally', st ? (st.checked ? `${bad(st.pending)} of ${num(st.entries)}` : `not checked: ${esc(st.note)}`) : '–'],
    [gp?.label ? `${esc(gp.label)} journals from the last matched file (${esc(gp.file || '')})` : 'Payment Gateway journals',
      gp && gp.missing != null ? `${bad(gp.missing)}${gp.commissionMissing ? ` + ${num(gp.commissionMissing)} commission day(s)` : ''}` : esc(gp?.note || '–')]]);
  h += failed(R, 'stock') + failed(R, 'gatewayPending');

  h += h2('COD import — last date done') + (L ? last(L.cod) : '') + h2('Payment Gateway — last date done') + (L ? last(L.gateway) : '') + failed(R, 'lastDates');
  return h + '</div>';
}
