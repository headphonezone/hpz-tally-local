// E-Way Bill and E-Invoice tabs: what Tally holds, what is missing, what has been closed.
//
// Live from Tally (lib/tally.mjs salesGstForDay, one request per invoice day), joined with Supabase:
//   gst_dispatch_log         a document was closed (dispatched / handled) — by whom, why
//   gst_exception_close_log  a missing-document row was closed — by whom, why
//   gst_returns              the invoice came back (credit note) — nothing left to dispatch
//   ewb_portal_check*        saved GSP portal checks (e-Way Bill only) — see portalCheck()
// The 9am reminder mail reads the same tables, so a Close here is a Close there too.
//
// THE RULES (same as gst_exceptions.py / v_pending_dispatch, so the app and the mail agree):
//   e-Way Bill due  : Sales voucher worth more than EWB_THRESHOLD (50,000), intra- or interstate alike.
//   e-Invoice due   : the customer is GST-registered (Regular / Composition) — any value.
//   Close-by        : e-Way Bill 24 h, e-Invoice 3 days, from the acknowledgement time in Tally; when Tally has none,
//                     from the e-Way Bill's time on the portal (a saved Check portal), else from the time the voucher
//                     was posted in Tally (marked "posted"), else from the invoice date (marked "est.").
//   A cancelled invoice owes nothing. Tally does not always admit to a cancel, but a cancelled
//   voucher is left hollow — no value AND no party — and is treated as cancelled.

import { salesGstForDay } from './tally.mjs';
import * as db from './supabase.mjs';
import * as gsp from './gsp.mjs';
import * as bluedart from './bluedart.mjs';

export const EWB_THRESHOLD = Number(process.env.EWB_THRESHOLD || 50000);
const REGISTERED = new Set(['regular', 'composition']);
export const MAX_DAYS = 62;          // one Fetch; ~1.5 s of Tally per day
export const PORTAL_MAX_DAYS = 31;   // one Check portal; one paid call per day not yet pulled
const MAX_TALLY_DAYS = 90;           // invoice dates a portal check may need to look back over

export const KINDS = {
  ewb:  { docType: 'eway-bill', label: 'e-Way Bill', hours: 24 },
  einv: { docType: 'e-invoice', label: 'e-Invoice', hours: 72 },
};

// --- dates (always the IST calendar) ------------------------------------------------------------
export const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export function isoDays(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const ymd = (iso) => iso.replace(/-/g, '');
const gspDay = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
// '14/10/2026 08:57:00 PM' (IST, as the GSP sends it) -> Date
function gspTime(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(String(s || ''));
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if ((m[7] || '').toUpperCase() === 'PM') h += 12;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${String(h).padStart(2, '0')}:${m[5]}:${m[6] || '00'}+05:30`);
}
const fmtIst = (d) => d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';

const isCancelled = (v) => v.cancelled || (!v.value && !v.party);
// e-Way Bill numbers are stored both as "582090378727" and "5820 9037 8727" — compare without spaces.
const bare = (s) => String(s || '').replace(/\s+/g, '');
const spaced = (n) => (/^\d{12}$/.test(n) ? n.replace(/(\d{4})(?=\d)/g, '$1 ') : n);

// --- Tally -----------------------------------------------------------------------------------------
// One request per day, strictly one after another (tally.mjs queues them). The caller holds the
// app's Tally-busy flag for the whole run.
export async function readTally(days, onDay) {
  const out = [];
  for (let i = 0; i < days.length; i++) {
    out.push(...await salesGstForDay(ymd(days[i])));
    onDay?.(i + 1, days.length);
  }
  return out;
}

// --- the two lists ---------------------------------------------------------------------------------
function docRows(kind, vouchers) {
  const { hours } = KINDS[kind];
  const out = [];
  for (const v of vouchers) {
    // A cancelled document is KEPT, as status "cancelled" with the reason, never silently dropped:
    // the bill was made, and the list has to say it was cancelled (and what replaced it).
    const vCancelled = isCancelled(v);
    const base = {
      voucher_number: v.voucherNumber, voucher_type: v.voucherType, voucher_date: v.date, guid: v.guid,
      party: v.party, gstin: v.gstin, place_of_supply: v.placeOfSupply, value: v.value,
      reference: v.reference, awb: v.awb || null, shipped_by: v.shippedBy || null,
    };
    // doc_no is what gets WRITTEN on Close — Tally's own spelling, the same the nightly sync stored, so
    // the dashboard and the 9am mail see the Close. id / ref are the bare number, for matching and display.
    const live = v.ewbs.filter((e) => !e.cancelled).map((e) => e.no);
    const ewbCancelNote = (e) => (e.cancelled
      ? `e-Way Bill cancelled in Tally${e.cancelDate ? ` on ${e.cancelDate}` : ''}${live.length ? ` — replaced by ${live.join(', ')}` : ' — no new e-Way Bill on this invoice'}`
      : vCancelled ? 'invoice cancelled in Tally' : '');
    const docs = kind === 'ewb'
      ? v.ewbs.map((e) => ({ id: e.no, doc_no: e.raw || e.no, ref: e.no, doc_date: e.date || v.date, event_at: e.updatedAt, review: '',
          tally_cancelled: e.cancelled || vCancelled, cancel_note: ewbCancelNote(e) }))
      : v.irn
        ? [{ id: v.irn, doc_no: v.irn, ref: v.irnAckNo || `…${v.irn.slice(-12)}`, doc_date: v.date, event_at: v.irnAckAt,
             review: !v.irnAckNo && !v.irnAckAt && !v.irnCancelled ? 'IRN has no acknowledgement in Tally yet' : '',
             tally_cancelled: v.irnCancelled || vCancelled,
             cancel_note: v.irnCancelled ? 'IRN cancelled in Tally' : vCancelled ? 'invoice cancelled in Tally' : '' }]
        : [];
    for (const d of docs) {
      // Where the clock starts: the acknowledgement time Tally holds; else (a bill keyed in by hand has none) the time the
      // voucher was posted in Tally; else the start of the invoice date. For an e-Way Bill a saved portal check, if there
      // is one, replaces the last two (attachPortal).
      const basis = d.event_at ? 'tally' : v.postedAt ? 'posted' : 'invoice';
      const from = new Date(d.event_at || v.postedAt || `${v.date}T00:00:00+05:30`);
      out.push({ ...base, ...d, deadline: new Date(from.getTime() + hours * 3600e3).toISOString(), deadline_estimated: basis !== 'tally', deadline_basis: basis });
    }
  }
  return out;
}

function missingRows(kind, vouchers) {
  const today = istToday();
  const out = [];
  for (const v of vouchers) {
    if (isCancelled(v)) continue;   // a cancelled invoice owes nothing
    // Only a document still in force counts: an invoice whose e-Way Bill (or IRN) was cancelled and
    // never re-made is missing one, and the reason says so.
    const liveEwb = v.ewbs.filter((e) => !e.cancelled);
    const deadEwb = v.ewbs.filter((e) => e.cancelled).map((e) => e.no);
    let reason = null;
    if (kind === 'ewb' && v.value > EWB_THRESHOLD && !liveEwb.length) {
      const inter = v.placeOfSupply && v.placeOfSupply.toLowerCase() !== String(process.env.HOME_STATE || 'Tamil Nadu').toLowerCase();
      reason = `value ${Math.round(v.value).toLocaleString('en-IN')} > ${EWB_THRESHOLD.toLocaleString('en-IN')} (${inter ? `interstate to ${v.placeOfSupply}` : 'intrastate'}), `
        + (deadEwb.length ? `e-Way Bill ${deadEwb.join(', ')} was cancelled and no new one made` : 'no e-Way Bill');
    }
    if (kind === 'einv' && REGISTERED.has(String(v.regType).toLowerCase()) && (!v.irn || v.irnCancelled)) {
      reason = `registered customer (${v.regType}${v.gstin ? `, GSTIN ${v.gstin}` : ''}), `
        + (v.irn ? 'IRN was cancelled and no new one made' : 'no IRN');
    }
    if (!reason) continue;
    out.push({
      id: v.guid, guid: v.guid, voucher_number: v.voucherNumber, voucher_type: v.voucherType, voucher_date: v.date,
      party: v.party, gstin: v.gstin, reg_type: v.regType, place_of_supply: v.placeOfSupply, value: v.value,
      reference: v.reference, awb: v.awb || null, reason,
      days_open: Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${v.date}T00:00:00Z`)) / 864e5),
    });
  }
  return out;
}

// --- Supabase: closed, returned, portal -----------------------------------------------------------
function docStatus(r, now) {
  if (r.tally_cancelled) return 'cancelled';
  if (r.gsp_status === 'CNL') { r.cancel_note ||= 'cancelled on the e-Way Bill portal'; return 'cancelled'; }
  if (r.closed) return 'closed';
  if (r.returned) return 'returned';
  return r.deadline && new Date(r.deadline) < now ? 'overdue' : 'open';
}

function countDocs(rows) {
  const c = { all: rows.length, open: 0, overdue: 0, closed: 0, returned: 0, cancelled: 0, notintally: 0 };
  for (const r of rows) {
    c[r.status] = (c[r.status] || 0) + 1;
    if (r.portal?.state === 'not_in_tally' && ['open', 'overdue'].includes(r.status)) c.notintally++;
  }
  c.pending = c.open + c.overdue;
  return c;
}
function countMissing(rows) {
  const c = { all: rows.length, missing: 0, closed: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

// Everything Supabase knows about these rows. Never touches Tally, so it can run again at any time
// (after a Close or a portal check) on the report already in memory.
export async function enrich(report) {
  const { docType } = KINDS[report.kind];
  report.warnings = [];
  report.docs = report.docs.filter((r) => !r.portal_only);   // re-added fresh by attachPortal
  if (!db.configured()) {
    report.warnings.push('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY in .env) — closed status, returns and portal checks cannot be shown, and Close is disabled.');
  } else {
    try {
      // Portal rows first: a portal bill with no Tally row here gets one, and is then checked for
      // Close / return like every other row below.
      if (report.kind === 'ewb') {
        try { await attachPortal(report); } catch (err) {
          report.docs = report.docs.filter((r) => !r.portal_only);
          report.warnings.push(/ewb_portal_check/.test(err.message)
            ? 'Saved portal checks are not set up — run update_ewb_portal_check.sql in the Supabase SQL editor.'
            : `Saved portal checks could not be read: ${err.message}`);
        }
      }
      const all = report.docs;
      const closed = new Map((await db.selectIn('gst_dispatch_log', 'doc_no,dispatched_by,dispatched_at,note', 'doc_no',
        all.flatMap((r) => [r.doc_no, r.id, spaced(r.id)]), `&doc_type=eq.${docType}`)).map((l) => [bare(l.doc_no), l]));
      const returned = new Map((await db.selectIn('gst_returns', 'credit_note_number,original_invoice', 'original_invoice',
        all.map((r) => r.voucher_number))).map((x) => [x.original_invoice, x.credit_note_number]));
      for (const r of all) {
        const l = closed.get(bare(r.id));
        Object.assign(r, { closed: Boolean(l), closed_by: l?.dispatched_by || null, closed_at: l?.dispatched_at || null,
          close_note: l?.note || null, returned: returned.get(r.voucher_number) || null });
      }
      const mclosed = new Map((await db.selectIn('gst_exception_close_log', 'voucher_guid,closed_by,closed_at,note', 'voucher_guid',
        report.missing.map((r) => r.guid), `&doc_type=eq.${docType}`)).map((l) => [l.voucher_guid, l]));
      for (const r of report.missing) {
        const l = mclosed.get(r.guid);
        Object.assign(r, { closed: Boolean(l), closed_by: l?.closed_by || null, closed_at: l?.closed_at || null, close_note: l?.note || null });
      }
    } catch (err) {
      report.warnings.push(`Supabase: ${err.message}`);
    }
  }
  const now = new Date();
  for (const r of report.docs) r.status = docStatus(r, now);
  for (const r of report.missing) r.status = r.closed ? 'closed' : 'missing';
  report.counts = countDocs(report.docs);
  report.missingCounts = countMissing(report.missing);
  return report;
}

// Saved portal results onto the e-Way Bill rows. A portal bill dated inside the range with no row
// here (made in this range on an invoice from outside it, or not in Tally at all) gets a row of its own.
async function attachPortal(report) {
  const byNo = await db.selectIn('v_ewb_portal_check', '*', 'ewb_no', report.docs.map((r) => r.id));
  const byDate = await db.sb(`v_ewb_portal_check?select=*&ewb_date=gte.${report.from}&ewb_date=lte.${report.to}`);
  const portal = new Map([...byNo, ...byDate].map((p) => [bare(p.ewb_no), p]));
  for (const r of report.docs) {
    const p = portal.get(r.id);
    if (p) {
      r.portal = portalInfo(p); r.gsp_status = p.gsp_status; portal.delete(r.id);
      // Tally has no time for this bill (it was keyed in by hand): the portal knows when it was really made.
      const made = r.deadline_basis !== 'tally' && gspTime(p.ewb_datetime);
      if (made) Object.assign(r, { deadline: new Date(made.getTime() + KINDS.ewb.hours * 3600e3).toISOString(), deadline_estimated: false, deadline_basis: 'portal' });
    }
  }
  for (const p of portal.values()) {
    if (p.ewb_date < report.from || p.ewb_date > report.to) continue;
    const made = gspTime(p.ewb_datetime);
    report.docs.push({
      id: String(p.ewb_no), doc_no: String(p.ewb_no), ref: String(p.ewb_no), portal_only: true,
      voucher_number: p.doc_no, voucher_date: gspDay(p.doc_date), doc_date: p.ewb_date,
      party: null, value: null, awb: p.awb, place_of_supply: p.del_place,
      deadline: made ? new Date(made.getTime() + 24 * 3600e3).toISOString() : null, deadline_estimated: !made, deadline_basis: made ? 'portal' : 'invoice',
      gsp_status: p.gsp_status, portal: portalInfo(p), review: '',
    });
  }
  const checked = await db.sb(`ewb_portal_check_day?select=check_date,checked_at&check_date=gte.${report.from}&check_date=lte.${report.to}`);
  const done = new Set(checked.map((c) => c.check_date));
  report.portalDays = { checked: [...done].sort(), notChecked: isoDays(report.from, report.to).filter((d) => !done.has(d)) };
}

const portalInfo = (p) => ({ state: p.state, note: p.state_note, awb: p.awb, courier: p.courier, gsp_status: p.gsp_status,
  checked_at: p.compared_at || p.fetched_at });

export async function buildReport(kind, from, to, vouchers, company) {
  const report = {
    kind, from, to, company, builtAt: new Date().toISOString(),
    docs: docRows(kind, vouchers), missing: missingRows(kind, vouchers), vouchersRead: vouchers.length,
  };
  return enrich(report);
}

// --- Close ---------------------------------------------------------------------------------------
// A document (open on the e-Way Bill / e-Invoice list) -> gst_dispatch_log, keyed by the FULL doc
// number (the whole IRN for an e-Invoice). A missing-document row -> gst_exception_close_log, keyed
// by the voucher GUID and the type, so an invoice missing both can be closed on one tab only.
// Inserted, never updated: a second Close is "already closed", and undoing one is a deliberate act
// in Supabase.
export async function close(report, list, id, who, reason) {
  const { docType } = KINDS[report.kind];
  const rows = list === 'missing' ? report.missing : report.docs;
  const row = rows.find((r) => r.id === id);
  if (!row) throw Object.assign(new Error('that row is not in the fetched list — press Fetch again'), { status: 404 });
  if (row.status === 'cancelled') throw Object.assign(new Error(`it is cancelled (${row.cancel_note}) — there is nothing to close`), { status: 409 });
  if (row.closed) return { already: true, row };
  const body = list === 'missing'
    ? { voucher_guid: row.guid, doc_type: docType, voucher_number: row.voucher_number, closed_by: who, note: reason }
    : { doc_type: docType, doc_no: row.doc_no, voucher_number: row.voucher_number, dispatched_by: who, note: reason };
  let already = false;
  try {
    await db.sb(list === 'missing' ? 'gst_exception_close_log' : 'gst_dispatch_log', { method: 'POST', body, prefer: 'return=minimal' });
  } catch (err) {
    if (err.status !== 409) throw err;
    already = true;   // someone closed it first — either way it is closed
  }
  await enrich(report);
  return { already, row: rows.find((r) => r.id === id) || row };
}

// --- Check portal (e-Way Bill) ---------------------------------------------------------------------
// GSP calls counted so far (data/gsp-calls.jsonl) — shown on the tab at all times.
export const gspUsage = () => gsp.usage();

// A day pulled AFTER it ended is complete: nothing new can be generated on it, so it is never pulled
// again. Today (or a day pulled while still running) is pulled again on the next check.
export async function portalPlan(from, to) {
  const days = isoDays(from, to);
  const saved = await db.sb(`ewb_portal_check_day?select=check_date,checked_at&check_date=gte.${from}&check_date=lte.${to}`);
  const done = new Set(saved.filter((s) => istDay(s.checked_at) > s.check_date).map((s) => s.check_date));
  return {
    days, done: days.filter((d) => done.has(d)), toFetch: days.filter((d) => !done.has(d)),
    usage: gsp.usage(), gspConfigured: gsp.configured(),
  };
}

// Pull the not-yet-pulled days from the GSP (paid), save each the moment it arrives, then check EVERY
// saved bill in the range against live Tally (free): is each portal e-Way Bill in Tally at all?
// Dispatch is NOT checked here — that is the scheduled BlueDart job, autoCloseDispatched() below.
// `readDays` reads Tally for a list of ISO days — the server passes it in while holding Tally.
// `pullOnly` (Tally is closed): save the portal's list and times, and stop — no bill is compared with Tally, so none is
// wrongly stored as "not in Tally" because Tally could not be asked.
export async function portalCheck(from, to, { readDays, onProgress = () => {}, pullOnly = false }) {
  const plan = await portalPlan(from, to);   // also proves the tables exist before anything is paid for
  const before = gsp.usage().total;
  const perDay = [];
  for (let i = 0; i < plan.toFetch.length; i++) {
    const d = plan.toFetch[i];
    onProgress(`Pulling ${d} from the GSP portal (${i + 1}/${plan.toFetch.length})…`);
    const { rows, note } = await gsp.ewbsForDay(d);
    const now = new Date().toISOString();
    if (rows.length) {
      await db.upsert('ewb_portal_check', rows.map((r) => ({
        ewb_no: String(r.ewbNo), ewb_date: d, doc_no: r.docNo, doc_date: r.docDate, gsp_status: r.status, raw: r, fetched_at: now,
      })), 'ewb_no');
    }
    await db.upsert('ewb_portal_check_day', [{ check_date: d, checked_at: now, ewb_count: rows.length, note }], 'check_date');
    perDay.push({ date: d, count: rows.length, note });
  }

  if (pullOnly) {
    const have = await db.sb(`ewb_portal_check?select=ewb_no&ewb_date=gte.${from}&ewb_date=lte.${to}`);
    const usage = gsp.usage();
    return { from, to, fetched: plan.toFetch, alreadySaved: plan.done, perDay, bills: have.length, pullOnly: true, notInTally: 0, notInTallyList: [],
      calls: { thisCheck: usage.total - before, ...usage } };
  }

  onProgress('Checking every portal bill against Tally…');
  const saved = await db.sb(`ewb_portal_check?select=ewb_no,ewb_date,raw&ewb_date=gte.${from}&ewb_date=lte.${to}`);
  const bills = saved.map((s) => ({ ...s.raw, ewbNo: String(s.raw.ewbNo), _day: s.ewb_date }));
  const live = bills.filter((b) => b.status === 'ACT');

  // Tally: the checked days PLUS each portal bill's own invoice date, so an e-Way Bill made today on
  // last week's invoice is still found.
  const tallyDays = [...new Set([...isoDays(from, to), ...live.map((b) => gspDay(b.docDate)).filter(Boolean)])]
    .sort().slice(-MAX_TALLY_DAYS);
  const vouchers = await readDays(tallyDays);
  const byEwb = new Map(), byVoucher = new Map();
  for (const v of vouchers) {
    for (const e of v.ewbs) byEwb.set(e.no, { awb: v.awb || null, voucher: v.voucherNumber, raw: e.raw || e.no });
    // A voucher number can repeat (a cancelled bill and its replacement) — keep the one with an AWB.
    if (!byVoucher.has(v.voucherNumber) || (v.awb && !byVoucher.get(v.voucherNumber).awb)) byVoucher.set(v.voucherNumber, { awb: v.awb || null, voucher: v.voucherNumber });
  }
  const tallyOf = (b) => byEwb.get(b.ewbNo) || byVoucher.get(b.docNo) || null;

  // Closed under either spelling of the number counts as closed.
  const now = new Date().toISOString(), out = [];
  for (const b of bills) {
    const t = tallyOf(b);
    let state, note;
    if (b.status !== 'ACT') { state = 'cancelled'; note = 'cancelled on the portal'; }
    else if (!t) { state = 'not_in_tally'; note = 'on the portal but no matching e-Way Bill or invoice in Tally (checked live)'; }
    else { state = 'in_tally'; note = `in Tally on ${t.voucher}`; }
    const { _day, ...raw } = b;
    out.push({ ewb_no: b.ewbNo, ewb_date: _day, doc_no: b.docNo, doc_date: b.docDate, gsp_status: b.status, raw,
      awb: t?.awb || null, courier: null, state, state_note: note, compared_at: now });
  }
  await db.upsert('ewb_portal_check', out, 'ewb_no');

  const usage = gsp.usage();
  return {
    from, to, fetched: plan.toFetch, alreadySaved: plan.done, perDay, bills: bills.length,
    notInTally: out.filter((o) => o.state === 'not_in_tally').length,
    notInTallyList: out.filter((o) => o.state === 'not_in_tally').map((o) => `${o.ewb_no} (doc ${o.doc_no})`),
    calls: { thisCheck: usage.total - before, ...usage },
  };
}

// --- Scheduled BlueDart check (server runs it every BLUEDART_AUTO_MINUTES) -----------------------
// Every still-open e-Way Bill and e-Invoice on the invoices read from Tally, whose AWB the BlueDart
// manifest shows dispatched by one of DISPATCH_COURIERS, is closed in gst_dispatch_log — exactly as
// bluedart_dispatch_sync.py does, so the dashboard, the 9am mail and these tabs all clear. A document
// already closed (by anyone) is left exactly as it was.
export const autoConfigured = () => bluedart.configured() && db.configured();

export async function autoCloseDispatched(vouchers) {
  const rows = [];
  for (const kind of Object.keys(KINDS)) {
    for (const r of docRows(kind, vouchers)) if (!r.tally_cancelled && r.awb) rows.push({ ...r, doc_type: KINDS[kind].docType });
  }
  const logged = new Set();
  for (const { docType } of Object.values(KINDS)) {
    const mine = rows.filter((r) => r.doc_type === docType);
    for (const l of await db.selectIn('gst_dispatch_log', 'doc_no', 'doc_no', mine.flatMap((r) => [r.doc_no, r.id, spaced(r.id)]), `&doc_type=eq.${docType}`)) {
      logged.add(`${docType}|${bare(l.doc_no)}`);
    }
  }
  const open = rows.filter((r) => !logged.has(`${r.doc_type}|${bare(r.id)}`));
  const manifest = await bluedart.manifestFor(open.map((r) => r.awb));
  const couriers = bluedart.couriers();
  const toClose = [];
  for (const r of open) {
    const m = manifest.get(r.awb);
    if (!m?.dispatchedAt || !couriers.includes(m.courier)) continue;
    toClose.push({ doc_type: r.doc_type, doc_no: r.doc_no, voucher_number: r.voucher_number, dispatched_by: 'bluedart',
      note: `AWB ${r.awb} dispatched ${fmtIst(m.dispatchedAt)} (manifest, ${m.courier}), scheduled check` });
  }
  if (toClose.length) {
    await db.sb('gst_dispatch_log?on_conflict=doc_type,doc_no', { method: 'POST', body: toClose,
      prefer: 'resolution=ignore-duplicates,return=minimal' });
  }
  return {
    open: open.length, inManifest: open.filter((r) => manifest.has(r.awb)).length, closed: toClose.length,
    closedList: toClose.map((x) => `${x.voucher_number} (${x.doc_type === 'eway-bill' ? 'EWB' : 'IRN'})`),
  };
}
