// The daily dispatch report mail: every e-Way Bill and e-Invoice not yet dispatched, overdue first, as a PDF.
//
// It replaces dispatch_email.py (E-way bill automation folder), which only read Supabase's v_pending_dispatch —
// Tally as of the previous evening's sync, never the portal. This one is built from LIVE Tally and, for the
// e-Way Bills, from the GSP portal check made a moment before it (server.mjs dispatchMailRun): the close-by
// clock of a bill keyed in by hand starts from the portal's time, and a bill made on the portal but never
// entered in Tally is listed too. The layout, subject, recipients and "Hi, PFA" cover note are the old mail's.
//
// This file only builds, prints and sends; reading Tally and the portal belongs to the server (it holds the
// Tally-busy flag), which passes the reports in.
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const RULE = { ewb: '24 hours', einv: '3 days' };

// Still to dispatch: open or overdue (closed, returned and cancelled ones are not chased). Overdue first, then by deadline.
export function pendingOf(report) {
  const rank = (r) => (r.status === 'overdue' ? 0 : 1);
  const at = (r) => (r.deadline ? Date.parse(r.deadline) : Infinity);
  return report.docs.filter((r) => r.status === 'open' || r.status === 'overdue').sort((a, b) => rank(a) - rank(b) || at(a) - at(b));
}

const esc = (v) => (v === null || v === undefined || v === '' ? '&mdash;'
  : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '&mdash;'
  : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const stamp = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const istDate = (d) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const istTime = (d) => d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

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

function portalCell(r) {
  if (!r.portal) return '&mdash;';
  if (r.portal.state === 'not_in_tally') return '<b style="color:#c0392b">on portal, NOT in Tally</b>';
  if (r.portal.state === 'in_tally') return 'on portal, in Tally';
  return esc(r.portal.state);
}

function table(kind, rows, overdue, now, forPdf) {
  const th = (t, a = 'left') => `<th align='${a}' style='padding:8px 10px'>${t}</th>`;
  const cell = 'padding:8px 10px;border-top:1px solid #e6e8ec';
  const head = `<tr style="background:#f4f5f7;color:#5b6270;font-size:11px;text-transform:uppercase;letter-spacing:.04em">`
    + th('Voucher') + th(kind === 'ewb' ? 'e-Way Bill No' : 'Ack No') + (forPdf ? '' : th('Party')) + th('Value', 'right')
    + th('Despatch / Cancel by (IST)') + (kind === 'ewb' ? th('Portal') : '') + '</tr>';
  const colour = overdue ? '#c0392b' : '#2c3e50';
  const body = rows.map((r) => '<tr>'
    + `<td style='${cell}'>${esc(r.voucher_number)}</td>`
    + `<td style='${cell};font-family:monospace;font-size:12px'>${esc(r.ref || r.doc_no)}</td>`
    + (forPdf ? '' : `<td style='${cell}'>${esc(r.party)}</td>`)
    + `<td style='${cell}' align='right'>${money(r.value)}</td>`
    + `<td style='${cell};color:${colour}'>${deadlineCell(r, now, forPdf)}</td>`
    + (kind === 'ewb' ? `<td style='${cell};font-size:12px'>${portalCell(r)}</td>` : '')
    + '</tr>').join('');
  return `<table cellpadding='0' cellspacing='0' style='width:100%;border-collapse:collapse;font-size:13px'><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function section(kind, report, now, forPdf) {
  const rows = pendingOf(report), overdue = rows.filter((r) => r.status === 'overdue'), pending = rows.filter((r) => r.status !== 'overdue');
  let out = `<h2 style='font-size:15px;margin:28px 0 4px'>${LABELS[kind]}</h2>`
    + `<div style='color:#8b92a3;font-size:12px;margin-bottom:10px'>deadline: ${RULE[kind]} from creation</div>`;
  if (!rows.length) return `${out}<div style='color:#27ae60;font-size:13px;padding:6px 0'>Nothing pending.</div>`;
  if (overdue.length) out += `<div style='background:#fdeaea;border-left:3px solid #c0392b;padding:8px 12px;margin:12px 0 6px;font-weight:600;color:#c0392b;font-size:13px'>OVERDUE &mdash; ${overdue.length}</div>${table(kind, overdue, true, now, forPdf)}`;
  if (pending.length) out += `<div style='background:#f4f5f7;border-left:3px solid #8b92a3;padding:8px 12px;margin:16px 0 6px;font-weight:600;font-size:13px'>Pending dispatch &mdash; ${pending.length}</div>${table(kind, pending, false, now, forPdf)}`;
  return out;
}

// What the portal check found, in a few lines under the heading — or the plain statement that it did not happen.
function portalNote(portal, portalError, skipped) {
  const box = (bg, edge, fg, html) => `<div style='margin:14px 0 0;padding:10px 12px;background:${bg};border-left:3px solid ${edge};font-size:12px;color:${fg}'>${html}</div>`;
  if (portalError) return box('#fdeaea', '#c0392b', '#7b241c', `<b>The GSP portal check FAILED</b> (${esc(portalError)}). The e-Way Bills below were compared with Tally only.`);
  if (skipped) return box('#fff8e6', '#d9a441', '#6b5417', 'The GSP portal was <b>not</b> checked for this report; the e-Way Bills below are Tally only.');
  const bits = [`<b>e-Way Bills checked against the GSP portal</b>: ${portal.bills} bill(s) on the portal (${portal.from} to ${portal.to})`];
  bits.push(portal.notInTally ? `<b style="color:#c0392b">${portal.notInTally} NOT in Tally</b>: ${esc(portal.notInTallyList.join(', '))}` : 'every one of them is in Tally');
  const empty = (portal.perDay || []).filter((d) => d.note);
  if (empty.length) bits.push(`no portal list for ${esc(empty.map((d) => `${d.date} (${d.note})`).join(', '))}`);
  return box('#eef4ff', '#1f4fa3', '#1f4fa3', bits.join(' &mdash; '));
}

// reports: { ewb, einv } from gst.buildReport; portal: gst.portalCheck's result (or null); portalError / skipped say why not.
export function render({ reports, portal = null, portalError = '', portalSkipped = false, closed = null, now = new Date() }) {
  const counts = {};
  for (const k of Object.keys(LABELS)) { const rows = pendingOf(reports[k]); counts[k] = { overdue: rows.filter((r) => r.status === 'overdue').length, pending: rows.filter((r) => r.status !== 'overdue').length }; }
  const totalOver = counts.ewb.overdue + counts.einv.overdue, totalPend = counts.ewb.pending + counts.einv.pending;
  const banner = totalOver ? `<div style='background:#c0392b;color:#fff;padding:12px 16px;border-radius:6px;font-weight:600'>${totalOver} document(s) OVERDUE for dispatch</div>`
    : totalPend ? `<div style='background:#eef4ff;color:#1f4fa3;padding:12px 16px;border-radius:6px;font-weight:600'>${totalPend} document(s) pending dispatch, none overdue</div>`
      : `<div style='background:#eafaf1;color:#1e8449;padding:12px 16px;border-radius:6px;font-weight:600'>All clear &mdash; nothing pending dispatch</div>`;
  const summary = Object.keys(LABELS).map((k) => `${LABELS[k]} ${counts[k].overdue} overdue / ${counts[k].pending} pending`).join(', ');

  const build = (forPdf) => `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#22262e;max-width:860px;margin:0 auto;padding:20px">
  <div style="font-size:12px;color:#8b92a3;margin-bottom:4px">Headphone Zone Pvt Ltd &mdash; Chennai</div>
  <h1 style="font-size:19px;margin:0 0 16px">Dispatch status &mdash; ${istDate(now)}</h1>
  ${banner}
  ${portalNote(portal, portalError, portalSkipped)}
  ${section('ewb', reports.ewb, now, forPdf)}
  ${section('einv', reports.einv, now, forPdf)}
  <div style="margin-top:32px;padding-top:12px;border-top:1px solid #e6e8ec;color:#8b92a3;font-size:11px">
    Generated ${istTime(now)} IST from live Tally${portal ? ' and the GSP portal' : ''}.${closed?.closed ? ` ${closed.closed} document(s) the courier had already dispatched were closed first.` : ''}
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
export async function buildPdf(html, outPath, now = new Date()) {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) return null;
  const dir = mkdtempSync(join(tmpdir(), 'dispatch_pdf_'));
  try {
    const src = join(dir, 'report.html');
    writeFileSync(src, `<!doctype html><html><head><meta charset='utf-8'><title>Dispatch status ${istDate(now)}</title><style>${PRINT_CSS}</style></head><body>`
      + `${html.replace('<div style="font-family:', '<div class="sheet" style="font-family:')}</body></html>`);
    await new Promise((resolve) => {
      const p = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=10000', `--print-to-pdf=${outPath}`, pathToFileURL(src).href], { stdio: 'ignore' });
      const timer = setTimeout(() => { p.kill(); resolve(); }, 120e3);
      p.on('exit', () => { clearTimeout(timer); resolve(); });
      p.on('error', () => { clearTimeout(timer); resolve(); });
    });
    return existsSync(outPath) && statSync(outPath).size > 0 ? outPath : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
