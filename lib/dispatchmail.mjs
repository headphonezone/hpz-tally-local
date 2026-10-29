// The daily dispatch report mail: what was CREATED yesterday and still needs someone — e-Way Bills / e-Invoices not yet
// dispatched, portal e-Way Bills that are not in Tally, and invoices that are missing their e-Way Bill / e-Invoice — as a PDF.
//
// It replaces dispatch_email.py (E-way bill automation folder), which only read Supabase's v_pending_dispatch —
// Tally as of the previous evening's sync, never the portal. This one is built from Tally and, for the e-Way Bills, from
// the GSP portal check made a moment before it (server.mjs dispatchMailRun). The day a document belongs to is the day it
// was MADE (the portal's e-Way Bill time, the IRN acknowledgement time), not its invoice date: a bill made yesterday on an
// invoice from last week is yesterday's. Only "missing" goes by invoice date, because a missing document has no time.
// The subject, recipients and "Hi, PFA" cover note are the old mail's.
//
// This file only builds, prints and sends; reading Tally and the portal belongs to the server (it holds the
// Tally-busy flag), which passes the reports in.
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';

const env = (k, d = '') => String(process.env[k] ?? d).trim();

export const enabled = () => env('DISPATCH_MAIL').toLowerCase() === 'on';
export const recipients = (raw = env('MAIL_TO')) => [...new Set(String(raw).replace(/;/g, ',').split(',').map((s) => s.trim()).filter(Boolean))];
export const configured = () => ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_TO'].every((k) => env(k));
// When the mail is due, "HH:MM" IST, as minutes after midnight.
export function dueMinutes() {
  const m = /^(\d{1,2}):(\d{2})$/.exec(env('DISPATCH_MAIL_TIME', '09:00'));
  return m ? Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2])) : 9 * 60;
}

// --- what goes in the report -------------------------------------------------------------------------
const LABELS = { ewb: 'e-Way Bills', einv: 'e-Invoices' };
const MISSING_WHAT = { ewb: 'e-Way Bill', einv: 'e-Invoice' };
// The close-by rule (gst.KINDS hours): a document's close-by time is its creation time plus this, so creation = deadline - hours.
const HOURS = { ewb: 24, einv: 72 };
const istDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

// Still to dispatch: open or overdue (closed, returned and cancelled ones are not chased). Overdue first, then by deadline.
export function pendingOf(report) {
  const rank = (r) => (r.status === 'overdue' ? 0 : 1);
  const at = (r) => (r.deadline ? Date.parse(r.deadline) : Infinity);
  const replaced = new Set(supersededOf(report));
  return report.docs.filter((r) => !replaced.has(r) && (r.status === 'open' || r.status === 'overdue')).sort((a, b) => rank(a) - rank(b) || at(a) - at(b));
}

// A bill on the portal (no Tally row of its own) for an invoice whose e-Way Bill in Tally is now a DIFFERENT number: it was replaced
// (2026-10-28: 194151 went from 552096231805 to 512096949836). The invoice is accounted for, so the old bill is not chased.
export const supersededOf = (report) => report.docs.filter((r) => r.portal_only
  && report.docs.some((t) => !t.portal_only && !t.tally_cancelled && t.voucher_number === r.voucher_number && t.id !== r.id));

// The three lists of one kind for the report day (an ISO date).
//   notClosed  — made that day, not dispatched / closed (overdue first)
//   notInTally — e-Way Bills on the portal, made that day, that no Tally voucher holds
//   missing    — invoices DATED that day that should have an e-Way Bill / e-Invoice and have none (and were not closed as an exception)
export function itemsOf(kind, report, day) {
  const madeOn = (r) => r.deadline && istDay(Date.parse(r.deadline) - HOURS[kind] * 3600e3) === day;
  const unmatched = (r) => r.portal_only && r.portal?.state === 'not_in_tally';
  const replaced = new Set(supersededOf(report));
  return {
    notClosed: pendingOf(report).filter((r) => !unmatched(r) && madeOn(r)),
    notInTally: kind === 'ewb' ? report.docs.filter((r) => unmatched(r) && !replaced.has(r) && (r.status === 'open' || r.status === 'overdue')) : [],
    missing: report.missing.filter((r) => r.status === 'missing' && r.voucher_date === day),
  };
}

const esc = (v) => (v === null || v === undefined || v === '' ? '&mdash;'
  : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '&mdash;'
  : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const stamp = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const istDate = (d) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const istTime = (d) => d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const isoLabel = (iso) => istDate(new Date(`${iso}T12:00:00+05:30`));

// Where the close-by clock started, when it is not the acknowledgement time in Tally.
const BASIS = { portal: ' (portal time)', posted: ' (posted)', invoice: ' (est.)' };

function deadlineCell(r, now, forPdf) {
  if (!r.deadline) return 'no deadline (no time on the portal either)';
  const tag = BASIS[r.deadline_basis || (r.deadline_estimated ? 'invoice' : '')] || '';
  const base = `${stamp(r.deadline)}${tag}`;
  if (forPdf) return base;   // a printed sheet is read hours later: a countdown on paper is stale at once
  const hrs = (Date.parse(r.deadline) - now.getTime()) / 3600e3;
  if (hrs < 0) return `${base} &nbsp;(${-hrs >= 48 ? `${Math.round(-hrs / 24)} days` : `${Math.round(-hrs)} hrs`} late)`;
  return `${base} &nbsp;(${hrs < 24 ? `${Math.round(hrs)} hrs` : `${Math.round(hrs / 24)} days`} left)`;
}

const CELL = 'padding:8px 10px;border-top:1px solid #e6e8ec';
const th = (t, a = 'left') => `<th align='${a}' style='padding:8px 10px'>${t}</th>`;
const HEAD = (cols) => `<tr style="background:#f4f5f7;color:#5b6270;font-size:11px;text-transform:uppercase;letter-spacing:.04em">${cols.join('')}</tr>`;
const tbl = (cols, rows) => `<table cellpadding='0' cellspacing='0' style='width:100%;border-collapse:collapse;font-size:13px'><thead>${HEAD(cols)}</thead><tbody>${rows.join('')}</tbody></table>`;
const MONO = `${CELL};font-family:monospace;font-size:12px`;
const band = (bg, edge, fg, text) => `<div style='background:${bg};border-left:3px solid ${edge};padding:8px 12px;margin:14px 0 6px;font-weight:600;color:${fg};font-size:13px'>${text}</div>`;

function notClosedTable(kind, rows, now, forPdf) {
  return tbl([th(kind === 'ewb' ? 'e-Way Bill No' : 'e-Invoice (Ack No)'), th('Voucher'), th('Despatch / Cancel by (IST)')],
    rows.map((r) => `<tr><td style='${MONO}'>${esc(r.ref || r.doc_no)}</td><td style='${CELL}'>${esc(r.voucher_number)}</td>`
      + `<td style='${CELL};color:${r.status === 'overdue' ? '#c0392b' : '#2c3e50'}'>${deadlineCell(r, now, forPdf)}</td></tr>`));
}

function notInTallyTable(rows) {
  return tbl([th('e-Way Bill No'), th('Invoice no. on the portal')],
    rows.map((r) => `<tr><td style='${MONO}'>${esc(r.ref || r.doc_no)}</td><td style='${CELL}'>${esc(r.voucher_number)}</td></tr>`));
}

function missingTable(rows, forPdf) {
  return tbl([th('Voucher'), forPdf ? '' : th('Party'), th('Value', 'right'), th('Why')],
    rows.map((r) => `<tr><td style='${CELL}'>${esc(r.voucher_number)}</td>${forPdf ? '' : `<td style='${CELL}'>${esc(r.party)}</td>`}`
      + `<td style='${CELL}' align='right'>${money(r.value)}</td><td style='${CELL};font-size:12px'>${esc(r.reason)}</td></tr>`));
}

function section(kind, items, now, forPdf, offline) {
  let out = `<h2 style='font-size:15px;margin:28px 0 4px'>${LABELS[kind]}</h2>`;
  if (!items.notClosed.length && !items.notInTally.length && !items.missing.length) return `${out}<div style='color:#27ae60;font-size:13px;padding:6px 0'>Nothing to act on.</div>`;
  const overdue = items.notClosed.filter((r) => r.status === 'overdue').length;
  if (items.notClosed.length) out += band(overdue ? '#fdeaea' : '#f4f5f7', overdue ? '#c0392b' : '#8b92a3', overdue ? '#c0392b' : '#22262e',
    `Not closed &mdash; ${items.notClosed.length}${overdue ? ` (${overdue} overdue)` : ''}`) + notClosedTable(kind, items.notClosed, now, forPdf);
  if (items.notInTally.length) out += band('#fdeaea', '#c0392b', '#c0392b', offline
    ? `On the portal, not matched in the saved Tally data (Tally was closed) &mdash; ${items.notInTally.length}`
    : `On the portal but NOT in Tally &mdash; ${items.notInTally.length}`) + notInTallyTable(items.notInTally);
  if (items.missing.length) out += band('#fff8e6', '#d9a441', '#6b5417', `${MISSING_WHAT[kind]} missing &mdash; ${items.missing.length} invoice(s)`) + missingTable(items.missing, forPdf);
  return out;
}

// What the portal check found, in a line under the heading — or the plain statement that it did not happen.
const box = (bg, edge, fg, html) => `<div style='margin:14px 0 0;padding:10px 12px;background:${bg};border-left:3px solid ${edge};font-size:12px;color:${fg}'>${html}</div>`;

function portalNote(portal, portalError, skipped, tallyAsOf) {
  if (portalError) return box('#fdeaea', '#c0392b', '#7b241c', `<b>The GSP portal check FAILED</b> (${esc(portalError)}). The e-Way Bills below were compared with Tally only.`);
  if (skipped) return box('#fff8e6', '#d9a441', '#6b5417', 'The GSP portal was <b>not</b> checked for this report; the e-Way Bills below are Tally only.');
  if (tallyAsOf) return box('#fff8e6', '#d9a441', '#6b5417', `<b>Tally was not open</b>, so this report uses the Tally data as last read on <b>${istTime(new Date(tallyAsOf))} IST</b>: invoices made, or e-Way Bill / IRN numbers typed in, after that are not in it. The e-Way Bill list was pulled from the GSP portal just now (${portal.bills} bill(s) made on the day).`);
  return box('#eef4ff', '#1f4fa3', '#1f4fa3', `<b>e-Way Bills checked against the GSP portal</b>: ${portal.bills} bill(s) made on the day. e-Invoices are compared with Tally only.`);
}

// reports: { ewb, einv } from gst.buildReport; day: the ISO day the report is about (yesterday); portal: gst.portalCheck's result (or null).
export function render({ reports, portal = null, portalError = '', portalSkipped = false, closed = null, tallyAsOf = null, day, now = new Date() }) {
  const items = Object.fromEntries(Object.keys(LABELS).map((k) => [k, itemsOf(k, reports[k], day)]));
  const counts = {};
  for (const k of Object.keys(LABELS)) {
    const it = items[k];
    counts[k] = { notClosed: it.notClosed.length, overdue: it.notClosed.filter((r) => r.status === 'overdue').length, notInTally: it.notInTally.length, missing: it.missing.length };
  }
  const total = Object.values(counts).reduce((n, c) => n + c.notClosed + c.notInTally + c.missing, 0);
  const totalOver = Object.values(counts).reduce((n, c) => n + c.overdue, 0);
  const banner = total
    ? `<div style='background:${totalOver ? '#c0392b' : '#1f4fa3'};color:#fff;padding:12px 16px;border-radius:6px;font-weight:600'>${total} item(s) to act on${totalOver ? ` &mdash; ${totalOver} OVERDUE for dispatch` : ''}</div>`
    : `<div style='background:#eafaf1;color:#1e8449;padding:12px 16px;border-radius:6px;font-weight:600'>All clear &mdash; nothing to act on</div>`;
  const summary = `e-Way Bills: ${counts.ewb.notClosed} not closed${counts.ewb.overdue ? ` (${counts.ewb.overdue} overdue)` : ''}, ${counts.ewb.notInTally} not in Tally, ${counts.ewb.missing} missing; `
    + `e-Invoices: ${counts.einv.notClosed} not closed${counts.einv.overdue ? ` (${counts.einv.overdue} overdue)` : ''}, ${counts.einv.missing} missing`;

  const build = (forPdf) => `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#22262e;max-width:860px;margin:0 auto;padding:20px">
  <div style="font-size:12px;color:#8b92a3;margin-bottom:4px">Headphone Zone Pvt Ltd &mdash; Chennai</div>
  <h1 style="font-size:19px;margin:0 0 4px">Dispatch status &mdash; ${istDate(now)}</h1>
  <div style="font-size:12px;color:#8b92a3;margin-bottom:16px">e-Way Bills and e-Invoices made on ${isoLabel(day)} (yesterday), whatever their invoice date; &ldquo;missing&rdquo; is invoices dated ${isoLabel(day)}</div>
  ${banner}
  ${portalNote(portal, portalError, portalSkipped, tallyAsOf)}
  ${section('ewb', items.ewb, now, forPdf, Boolean(tallyAsOf))}
  ${section('einv', items.einv, now, forPdf, false)}
  <div style="margin-top:32px;padding-top:12px;border-top:1px solid #e6e8ec;color:#8b92a3;font-size:11px">
    Generated ${istTime(now)} IST from ${tallyAsOf ? 'the last saved Tally read' : 'live Tally'}${portal ? ' and the GSP portal' : ''}.${closed?.closed ? ` ${closed.closed} document(s) the courier had already dispatched were closed first.` : ''}
    A document leaves this list when it is dispatched (BlueDart manifest) or someone presses Close on the tracking dashboard.
  </div>
</div>`;
  const subject = `Status of E-Way Bill / E-Invoices - ${istDate(now)}`;
  const text = `Dispatch status - ${istTime(now)} IST\n${summary}\n`;
  return { subject, html: build(false), pdfHtml: build(true), text, counts, summary };
}

// --- PDF: the same HTML, printed by Edge or Chrome (headless), as the old mail did ----------------------
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const PRINT_CSS = `@page { size: A4 portrait; margin: 12mm 10mm 14mm; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; } .sheet { max-width: none !important; padding: 0 !important; }
thead { display: table-header-group; } tr { break-inside: avoid; page-break-inside: avoid; }
h1, h2 { break-after: avoid; page-break-after: avoid; }`;

// -> the PDF's path, or null (no browser, or it failed — the mail then says so instead of "PFA" over nothing)
// The work folder (and the browser's profile) is made beside the PDF, in the app's data folder: the pm2 service runs as
// NT AUTHORITY\LocalService, which cannot write the user's Temp.
export async function buildPdf(html, outPath, now = new Date()) {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) return null;
  for (const old of readdirSync(dirname(outPath))) if (old.startsWith('pdf_work_')) { try { rmSync(join(dirname(outPath), old), { recursive: true, force: true }); } catch { /* still in use */ } }
  const dir = mkdtempSync(join(dirname(outPath), 'pdf_work_'));
  try {
    const src = join(dir, 'report.html');
    writeFileSync(src, `<!doctype html><html><head><meta charset='utf-8'><title>Dispatch status ${istDate(now)}</title><style>${PRINT_CSS}</style></head><body>`
      + `${html.replace('<div style="font-family:', '<div class="sheet" style="font-family:')}</body></html>`);
    await new Promise((resolve) => {
      const p = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`, '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=10000', `--print-to-pdf=${outPath}`, pathToFileURL(src).href], { stdio: 'ignore' });
      const timer = setTimeout(() => { p.kill(); resolve(); }, 120e3);
      p.on('exit', () => { clearTimeout(timer); resolve(); });
      p.on('error', () => { clearTimeout(timer); resolve(); });
    });
    return existsSync(outPath) && statSync(outPath).size > 0 ? outPath : null;
  } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* the browser may still hold its profile: the next run clears it */ } }
}

// --- sending ----------------------------------------------------------------------------------------
function transport() {
  const port = Number(env('SMTP_PORT', '587'));
  return nodemailer.createTransport({ host: env('SMTP_HOST'), port, secure: port === 465, auth: { user: env('SMTP_USER'), pass: env('SMTP_PASSWORD') } });
}
const from = () => `"${env('SMTP_FROM_NAME', 'Tally Dispatch Bot').replace(/"/g, '')}" <${env('SMTP_FROM') || env('SMTP_USER')}>`;

// The report mail: a covering note and the PDF. With no PDF the note says so (the report is the whole point of the mail).
export async function send({ subject, summary, to, pdfPath, now = new Date() }) {
  const day = istDate(now);
  const note = pdfPath ? `Hi,\n\nPFA\n\n${summary}\n`
    : `Hi,\n\nThe dispatch report for ${day} could not be attached - the PDF failed to generate. ${summary}. Please open the tracking dashboard instead.\n`;
  const body = (pdfPath ? `<p>Hi,</p><p>PFA</p><p style="color:#5b6270;font-size:13px">${esc(summary)}</p>`
    : `<p>Hi,</p><p style="color:#c0392b"><b>The dispatch report for ${day} could not be attached - the PDF failed to generate.</b> ${esc(summary)}. Please open the tracking dashboard instead.</p>`);
  await transport().sendMail({
    from: from(), to: to.join(', '), subject, text: note,
    html: `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#22262e">${body}</div>`,
    attachments: pdfPath ? [{ filename: `dispatch_status_${now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.pdf`, path: pdfPath }] : [],
  });
}

// When the report could not be built at all: silence would look exactly like a clean day.
export async function sendFailure({ to, reason, now = new Date() }) {
  const day = istDate(now);
  await transport().sendMail({
    from: from(), to: to.join(', '), subject: `Status of E-Way Bill / E-Invoices - ${day} - NOT SENT`,
    text: `Hi,\n\nThe dispatch report for ${day} could not be built: ${reason}\n\nPlease open the tracking dashboard instead, and check the app on the server PC.\n`,
  });
}
