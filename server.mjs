// Must stay the first import: it loads .env before lib/tally.mjs reads its URL at load time.
import './lib/env.mjs';

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ping, activeCompany, loadedCompanies, listGodowns, listStockItemNames, voucherNumbersOfType, importVouchers, importMasters, existingLedgers, allLedgerNamesByLower, creditNoteItems, readCreditNote, readSalesVouchersBatch } from './lib/tally.mjs';
import * as cn from './lib/creditnote.mjs';
import * as cnStore from './lib/cnstore.mjs';
import * as uc from './lib/uc.mjs';
import * as ucsales from './lib/ucsales.mjs';
import * as ucStore from './lib/ucstore.mjs';
import { buildReport } from './lib/report.mjs';
import { createMaterialOut } from './lib/create.mjs';
import { reportToXlsx, creditNoteReportToXlsx, gstReportToXlsx, missingInvoiceToXlsx } from './lib/excel.mjs';
import * as gst from './lib/gst.mjs';
import * as mi from './lib/missing.mjs';
import * as pu from './lib/purchase.mjs';
import * as cod from './lib/cod.mjs';
import { salesNumbersInRange, companyPeriod } from './lib/tally.mjs';
import * as sj from './lib/stockjournal.mjs';
import * as store from './lib/sjstore.mjs';
import * as rms from './lib/rms.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7654);

// Voucher numbers (RMS-N) come from Tally, per company: one past the highest RMS-N among the open
// company's Stock Journals. Tally holds every voucher that exists, so this stays right even if this
// app's local store is lost or someone posts or deletes an RMS voucher by hand. See nextVoucher().

let report = null;
let job = null; // { type, running, done, total, message, error }
let lastSeen = { tallyUp: false, openCompany: null, companies: [], period: null };

// A Stock Journal posting holds Tally for several requests in a row. Material Out and Stock
// Journal share this one busy check, so neither side — nor the status poll — can overlap the
// other on the gateway. Overlapping requests wedge Tally.
let sjBusy = false;
let cnBusy = false;   // the same rule for Credit Notes: a preview or a posting holds the gateway
let ucBusy = false;   // and for Unicommerce Sales
// cnJob/ucJob are declared further down with their own code; a whole build or create job counts as busy.
// E-Way Bill / E-Invoice tabs: one Fetch (or Check portal) job and one fetched list per tab, plus the
// scheduled BlueDart check (gstAutoBusy while it reads Tally).
const gstJob = { ewb: null, einv: null };
const gstReport = { ewb: null, einv: null };
let gstAutoBusy = false;
// Missing Invoice tab: one job and one report. miBusy only while it reads Tally — the Unicommerce
// lookups after that leave Tally free for everyone else.
let miJob = null, miReport = null, miBusy = false;
let piBusy = false;   // Purchase Import: a BOE lookup or a posting holds the gateway
// COD Import: one job (check or post) and one checked file.
let codJob = null, codReport = null;
const tallyBusy = () => Boolean(job?.running || sjBusy || cnBusy || cnJob?.running || ucBusy || ucJob?.running
  || gstJob.ewb?.running || gstJob.einv?.running || gstAutoBusy || miBusy || piBusy || codJob?.running);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

async function startBuild(book, from, to) {
  job = { type: 'build', running: true, done: 0, total: 0, message: 'Reading sheet and Tally…', error: '' };
  try {
    report = await buildReport({ book, from, to });
    job = { type: 'build', running: false, message: `Built in ${(report.tookMs / 1000).toFixed(1)}s`, error: '' };
  } catch (err) {
    job = { type: 'build', running: false, message: '', error: err.message };
  }
}

async function startCreate(wcids) {
  if (!report) throw new Error('build the report first');
  const wanted = new Set(wcids);
  const rows = report.rows.filter((r) => wanted.has(r.wcid));
  job = { type: 'create', running: true, done: 0, total: rows.length, message: 'Creating vouchers…', error: '' };
  try {
    const result = await createMaterialOut(rows, {
      report,
      onProgress: ({ done, total }) => { job.done = done; job.total = total; },
    });
    // Reflect the new vouchers so a created row cannot be submitted twice.
    const created = new Set(result.results.filter((r) => r.created).map((r) => r.wcid));
    for (const row of report.rows) {
      if (created.has(row.wcid)) { row.status = 'done'; row.reason = ''; }
    }
    report.counts = { ready: 0, done: 0, blocked: 0 };
    for (const r of report.rows) report.counts[r.status]++;
    job = { type: 'create', running: false, message: `Created ${result.created}, failed ${result.failed}`, error: '', result };
  } catch (err) {
    job = { type: 'create', running: false, message: '', error: err.message };
  }
}

// --- Stock Journal ------------------------------------------------------------------------

const REF_TYPES = ['RET', 'WCID', 'ORDER_ID'];
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// RMS write-back. The voucher is already confirmed in Tally by this point, so a failure here must
// not undo or hide the posting: it is recorded against the journal and can be retried.
async function syncToRms(journalId, voucherNumber, godown, entries) {
  const rmaNumbers = [...new Set(entries.map((e) => e.rma_number).filter(Boolean))];
  if (!rmaNumbers.length) { store.markSynced(journalId, false, 'no rma_numbers to record'); return { synced: false, error: 'no rma_numbers to record' }; }
  try {
    const r = await rms.record(voucherNumber, godown, rmaNumbers);
    const error = r.missing?.length ? `RMS did not find: ${r.missing.join(', ')}` : '';
    store.markSynced(journalId, !error, error);
    return { synced: !error, updated: r.updated, error };
  } catch (err) {
    store.markSynced(journalId, false, err.message);
    return { synced: false, error: err.message };
  }
}

// RMS write-back for a journal posted from a Movement of Stock batch: stamps that condition of the
// batch, and the RMS cases in it. Same contract as syncToRms — never undoes the posting, retryable.
async function syncMovementToRms(journalId, voucherNumber, godown, movement) {
  try {
    const r = await rms.movementRecord(movement.batch_id, movement.condition, voucherNumber, godown);
    store.markSynced(journalId, true);
    return { synced: true, updated: r.updated, cases_updated: r.cases_updated };
  } catch (err) {
    store.markSynced(journalId, false, err.message);
    return { synced: false, error: err.message };
  }
}

// Next RMS-N for a company: one past the highest RMS-N in that company's Stock Journals in Tally.
// The app's own record of what it posted there is used only as a floor, so a number it has issued
// is never handed out again even if that voucher was later deleted in Tally.
async function nextVoucher(company) {
  const taken = await sj.takenNumbers();
  const tallyMax = sj.highestRms(taken);
  const localMax = store.localMaxSeq(company);
  let seq = Math.max(tallyMax, localMax) + 1;
  while (taken.has(`RMS-${seq}`)) seq++;   // belt and braces; cannot normally happen
  return { seq, voucherNumber: `RMS-${seq}`, tallyMax, localMax };
}

// `movement` ({batch_id, condition}) is set only when the entries come from an RMS Movement of
// Stock batch: the journal remembers it, and the RMS write-back stamps that batch.
async function sjCreate(body, { movement = null } = {}) {
  const { entries: raw, fromGodown, toGodown, unboxed, narration, expectedCompany, force } = body;
  // "Test — don't update RMS": posts to Tally exactly as usual, but never writes back to production
  // RMS (and never counts towards the duplicate rule). The operator ticks it; there is deliberately
  // no rule based on the company name (the user's decision, 2026-09-29).
  const testMode = body.testMode === true;

  const entries = (Array.isArray(raw) ? raw : [])
    .filter((e) => e && e.reference && e.item)
    .map((e) => ({ reference: String(e.reference).trim(), item: String(e.item), rma_number: e.rma_number || null, qty: Number(e.qty) || 0 }));
  if (!entries.length) return [400, { error: 'add at least one reference' }];
  if (!sj.GODOWNS.includes(fromGodown)) return [400, { error: 'invalid From godown' }];
  if (!sj.GODOWNS.includes(toGodown)) return [400, { error: 'invalid To godown' }];
  if (fromGodown === toGodown) return [400, { error: 'From and To godown must differ' }];

  // Duplicate rule — reference + item + from + to. Local, so it answers even with Tally closed.
  // Not applied to test postings: those exist to try things out, and are not counted either.
  if (!force && !testMode) {
    const duplicates = store.findDuplicates(entries, fromGodown, toGodown);
    if (duplicates.length) return [409, { error: 'already posted', duplicates }];
  }

  if (tallyBusy()) return [409, { error: 'Tally is busy with another job — try again in a moment' }];
  sjBusy = true;
  try {
    if (!(await ping())) return [503, { error: 'Tally is not running' }];
    const company = await activeCompany();
    if (!company) return [503, { error: 'Tally is running but no company is open' }];
    // The operator confirmed a company on screen; never post into a different one.
    if (expectedCompany && company !== expectedCompany) {
      return [409, { error: `Tally's open company changed to "${company}". Check it is the right one, then try again.`, company }];
    }

    // Enforced here, not only in the UI: several companies share this Tally, and they do not all
    // have the same godowns. Never leave it to the import to decide what an unknown godown means.
    const godownsInTally = new Set(await listGodowns());
    const missingGodowns = [fromGodown, toGodown].filter((g) => !godownsInTally.has(g));
    if (missingGodowns.length) {
      return [422, { error: `Godown not found in "${company}": ${missingGodowns.join(', ')}` }];
    }

    const validation = await sj.validateNames(sj.aggregate(entries), Boolean(unboxed));
    if (!validation.ok) return [422, { error: 'name not matched', unmatched: validation.unmatched }];
    const lines = validation.lines;

    const { seq, voucherNumber } = await nextVoucher(company);
    const skipped = [];

    const refs = [...new Set(entries.map((e) => e.reference))];
    const narrationText = (narration && String(narration).trim()) || refs.join(', ');
    const voucher = sj.buildVoucher({
      voucherNumber, date: new Date(), fromGodown, toGodown, unboxed: Boolean(unboxed), narration: narrationText, lines,
    });

    const result = await sj.postAndVerify(voucher);
    if (!result.created) return [502, { error: result.error, voucherNumber, skipped }];

    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const id = store.insertJournal({
      seq, voucher_number: voucherNumber, voucher_date: todayISO(), company,
      from_godown: fromGodown, to_godown: toGodown, unboxed: Boolean(unboxed),
      narration: narrationText, refs, lines, total_qty: totalQty, test_mode: testMode, movement,
    }, entries);

    sjBusy = false; // Tally work is done; the RMS call below does not touch the gateway.
    if (testMode) {
      store.markSynced(id, false, 'test posting — RMS not updated');
      return [200, { created: true, id, voucherNumber, totalQty, company, skipped, rms: { synced: false, test: true } }];
    }
    const sync = movement
      ? await syncMovementToRms(id, voucherNumber, toGodown, movement)
      : await syncToRms(id, voucherNumber, toGodown, entries);
    return [200, { created: true, id, voucherNumber, totalQty, company, skipped, rms: sync }];
  } finally {
    sjBusy = false;
  }
}

async function handleStockJournal(url, req, res) {
  const p = url.pathname.slice('/api/sj'.length);
  const q = (k) => url.searchParams.get(k) || '';

  // Config for the tab: no Tally call, so it is safe to load at any time.
  if (p === '/config') {
    return json(res, 200, { godowns: sj.GODOWNS, rmsConfigured: rms.configured() });
  }

  // The number the next journal will get in the open company. Needs Tally, so it is skipped while
  // a posting holds the gateway; the create itself recomputes it at the moment of posting anyway.
  if (p === '/next') {
    if (tallyBusy()) return json(res, 200, { busy: true, voucherNumber: null });
    try {
      if (!(await ping())) return json(res, 200, { voucherNumber: null, reason: 'Tally is not running' });
      const company = await activeCompany();
      if (!company) return json(res, 200, { voucherNumber: null, reason: 'no company open in Tally' });
      const { voucherNumber, tallyMax, localMax } = await nextVoucher(company);
      return json(res, 200, { voucherNumber, company, tallyMax, localMax });
    } catch (err) {
      return json(res, 200, { voucherNumber: null, reason: err.message });
    }
  }

  // Which of the configured godowns exist in the open company. One Tally call; skipped while busy.
  if (p === '/godowns') {
    if (tallyBusy()) return json(res, 200, { busy: true, godowns: sj.GODOWNS.map((name) => ({ name, existsInTally: null })) });
    try {
      const inTally = new Set(await listGodowns());
      return json(res, 200, { godowns: sj.GODOWNS.map((name) => ({ name, existsInTally: inTally.has(name) })) });
    } catch (err) {
      return json(res, 200, { error: err.message, godowns: sj.GODOWNS.map((name) => ({ name, existsInTally: null })) });
    }
  }

  if (p === '/search') {
    if (!REF_TYPES.includes(q('type'))) return json(res, 400, { error: 'type must be RET, WCID or ORDER_ID' });
    try { return json(res, 200, await rms.search(q('type'), q('q'))); }
    catch (err) { return json(res, err.status || 502, { error: err.message }); }
  }

  // RMS says which items the reference covers; the local store says where each was posted before.
  if (p === '/lookup') {
    if (!REF_TYPES.includes(q('type'))) return json(res, 400, { error: 'type must be RET, WCID or ORDER_ID' });
    try {
      const data = await rms.lookup(q('type'), q('ref'));
      data.items = data.items.map((it) => ({ ...it, postedBefore: store.postedBefore(data.reference, it.item) }));
      return json(res, 200, data);
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    }
  }

  if (p === '/create' && req.method === 'POST') {
    const [code, body] = await sjCreate(await readBody(req));
    return json(res, code, body);
  }

  // RMS Movement of Stock batches still waiting for a Stock Journal, each condition shown with the
  // godowns it will move between. RMS only, no Tally call, so it loads even while Tally is busy.
  if (p === '/movement-batches') {
    try {
      const { batches } = await rms.movementBatches();
      for (const b of batches) {
        for (const g of b.groups) Object.assign(g, { fromGodown: sj.MOVEMENT_FROM, ...(sj.MOVEMENT_ROUTE[g.condition] || {}) });
      }
      return json(res, 200, { batches });
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    }
  }

  // Post one condition of a batch. The entries are re-read from RMS here — never taken from the
  // browser — then go through the normal sjCreate path (godown + name checks, RMS-N, read-back).
  if (p === '/movement-post' && req.method === 'POST') {
    const { batch_id, condition, expectedCompany, testMode, force } = await readBody(req);
    const route = sj.MOVEMENT_ROUTE[condition];
    if (!batch_id || !route) return json(res, 400, { error: 'batch_id and a valid condition are required' });
    let group;
    try {
      const { batches } = await rms.movementBatches();
      group = batches.find((b) => b.batch_id === batch_id)?.groups.find((g) => g.condition === condition);
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    }
    if (!group) return json(res, 409, { error: 'This batch is no longer pending in RMS — it may already be posted. Refresh the list.' });
    const refs = [...new Set(group.entries.map((e) => e.reference))];
    const [code, body] = await sjCreate({
      entries: group.entries, fromGodown: sj.MOVEMENT_FROM, toGodown: route.toGodown, unboxed: route.unboxed,
      narration: `Movement of Stock (${condition}): ${refs.join(', ')}`, expectedCompany, testMode, force,
    }, { movement: { batch_id, condition } });
    return json(res, code, body);
  }

  if (p === '/history') {
    return json(res, 200, { rows: store.listJournals({ q: q('q'), from: q('from'), to: q('to'), limit: q('limit') || 200 }) });
  }

  if (p === '/journal') {
    const j = store.getJournal(Number(q('id')));
    return j ? json(res, 200, j) : json(res, 404, { error: 'journal not found' });
  }

  // Retry an RMS write-back that failed after a successful Tally posting.
  if (p === '/resync' && req.method === 'POST') {
    const { id } = await readBody(req);
    const j = store.getJournal(Number(id));
    if (!j) return json(res, 404, { error: 'journal not found' });
    if (j.test_mode) return json(res, 409, { synced: false, error: 'test posting — RMS is never updated for it' });
    return json(res, 200, j.movement
      ? await syncMovementToRms(j.id, j.voucher_number, j.to_godown, j.movement)
      : await syncToRms(j.id, j.voucher_number, j.to_godown, j.entries));
  }

  return json(res, 404, { error: 'not found' });
}

// --- Credit Note (Goods Return) ------------------------------------------------------------
// RMS supplies the returns and the Unicommerce detail; lib/creditnote.mjs does the arithmetic (it
// reproduces the old Apps Script to the paisa); Tally is checked before and read back after posting.

const RET_TYPE = 'Credit Note (Return)';
let itemNamesCache = { at: 0, names: null };
async function stockItemNames() {
  if (!itemNamesCache.names || Date.now() - itemNamesCache.at > 10 * 60000) itemNamesCache = { at: Date.now(), names: new Set(await listStockItemNames()) };
  return itemNamesCache.names;
}
const ymdOf = (iso) => String(iso || '').slice(0, 10);

// Everything needed to show — or post — one credit note. Never trusts the browser: create() calls this
// again at the moment of posting. Must be called with cnBusy held (it talks to Tally several times).
// The open company and every credit-note number in it. Listing the numbers is the slow part of a check
// (two walks over thousands of vouchers), so a batch check reads it once and shares it.
async function cnTallyContext() {
  if (!(await ping())) throw Object.assign(new Error('Tally is not running'), { status: 503 });
  const company = await activeCompany();
  if (!company) throw Object.assign(new Error('Tally is running but no company is open'), { status: 503 });
  const grNos = new Set(await voucherNumbersOfType(cn.VOUCHER_TYPE));
  const retNos = new Set(await voucherNumbersOfType(RET_TYPE));
  return { company, grNos, retNos, allNos: new Set([...grNos, ...retNos]) };
}

// Existing credit notes (with items) for many orders in one Tally walk per voucher type.
async function cnExistingFor(orderNos, ctx) {
  const numsOf = new Map(orderNos.map((o) => [o, cn.numbersOfOrder(o, ctx.allNos)]));
  const all = [...numsOf.values()].flat();
  const byNo = new Map();
  for (const [type, set] of [[cn.VOUCHER_TYPE, ctx.grNos], [RET_TYPE, ctx.retNos]]) {
    const nums = all.filter((n) => set.has(n));
    for (let i = 0; i < nums.length; i += 200) {
      for (const x of await creditNoteItems(type, nums.slice(i, i + 200))) byNo.set(`${type}|${x.voucherNumber}`, { ...x, type });
    }
  }
  return new Map(orderNos.map((o) => [o, numsOf.get(o).flatMap((n) => [byNo.get(`${cn.VOUCHER_TYPE}|${n}`), byNo.get(`${RET_TYPE}|${n}`)].filter(Boolean))]));
}

// What the order's existing credit notes in Tally already credit: units per SKU, plus any lines whose
// item name matches nothing on the order (still counted, so a renamed item is not credited twice).
function cnCredited(existing, d) {
  const ucItems = d.unicommerce?.items || [];
  return { creditedUnits: cn.creditedUnitsBySku(existing, d.rows, ucItems), unmatched: cn.unmatchedCreditedLines(existing, d.rows, ucItems) };
}

async function cnPrepare(orderNo, rmaNumbers, shared = null) {
  const d = shared?.rms || await rms.cnOrder(orderNo);        // RMS + Unicommerce (not Tally)
  const problems = [], warnings = [];
  const wanted = rmaNumbers?.length ? new Set(rmaNumbers) : null;
  const selected = d.rows.filter((r) => (wanted ? wanted.has(r.rma_number) : !r.credit_note_no));
  for (const r of selected) if (r.credit_note_no) problems.push(`${r.item} (${r.rma_number}) is already on credit note ${r.credit_note_no} in RMS`);
  if (!selected.length) problems.push('nothing to credit — every item of this order already has a credit note in RMS');
  if (d.unicommerce_error) problems.push(`Unicommerce: ${d.unicommerce_error}`);

  const ctx = shared?.ctx || await cnTallyContext();
  const { company } = ctx;
  const taken = new Set([...ctx.allNos, ...cnStore.issuedNumbers(company)]);
  const existing = shared?.existing || (await cnExistingFor([d.order_no], ctx)).get(d.order_no);

  let note = null;
  if (!problems.length) {
    const res = cn.computeCreditNote({ rows: selected, uc: d.unicommerce, ...cnCredited(existing, d) });
    problems.push(...res.problems); warnings.push(...res.warnings);
    note = res.note || null;
  }
  if (note) {
    // Masters must exist exactly; Tally would otherwise reject the voucher or create something new.
    const needLedgers = [...new Set([note.party_ledger, ...note.lines.map((l) => l.ledger), ...note.tax.map((t) => t.ledger), ...(note.cod > 0 ? [cn.COD_LEDGER] : [])])];
    // A batch passes the ledgers it already found in one lookup; only names it has not seen are asked.
    const known = shared?.ledgers;
    const unknown = needLedgers.filter((l) => !known?.has(l));
    const have = new Set([...(known || []), ...(unknown.length ? await existingLedgers(unknown) : [])]);
    for (const l of needLedgers) if (!have.has(l)) problems.push(l === note.party_ledger ? `customer ledger "${l}" not found in Tally` : `ledger "${l}" not found in Tally`);
    const items = shared?.items || await stockItemNames();
    const byKey = new Map([...items].map((n) => [cn.itemKey(n), n]));
    for (const l of note.lines) {
      const exact = items.has(l.item) ? l.item : byKey.get(cn.itemKey(l.item));
      if (exact) l.item = exact;   // post under Tally's own spelling of the name
      else problems.push(`stock item "${l.item}" not found in Tally (name not matched)`);
    }
  }

  const dates = [...new Set(selected.map((r) => r.received_date).filter(Boolean))].sort();
  if (dates.length > 1) warnings.push(`items were received on different days (${dates.join(', ')}); the credit note is dated ${dates.at(-1)}`);
  return {
    order_no: d.order_no, sale_order_code: d.sale_order_code, customer_name: d.customer_name, company,
    rows: d.rows, selected: selected.map((r) => r.rma_number),
    voucher_number: cn.nextCreditNoteNumber(d.order_no, taken), voucher_date: dates.at(-1) || null,
    existing, note, problems, warnings,
  };
}

async function cnSyncToRms(id, voucherNumber, voucherDate, rmaNumbers) {
  try {
    const r = await rms.cnRecord(voucherNumber, voucherDate, rmaNumbers);
    cnStore.markSynced(id, true);
    return { synced: true, updated: r.updated };
  } catch (err) {
    const why = err.data?.already_on_another_credit_note?.length
      ? `RMS already has another credit note for ${err.data.already_on_another_credit_note.map((x) => `${x.rma_number} (${x.credit_note_no})`).join(', ')}`
      : err.message;
    cnStore.markSynced(id, false, why);
    return { synced: false, error: why };
  }
}

// Post one credit note. `inJob` = called by the batch-create job, which already holds the gateway;
// `shared` = that job's Tally context and master lists (RMS data and existing notes are always fresh).
async function cnCreate(body, { inJob = false, shared = null } = {}) {
  const { order_no, rma_numbers, expectedCompany } = body;
  const testMode = body.testMode === true;
  if (!order_no) return [400, { error: 'order_no is required' }];
  if (!inJob && tallyBusy()) return [409, { error: 'Tally is busy with another job — try again in a moment' }];
  cnBusy = true;
  try {
    const p = await cnPrepare(String(order_no), Array.isArray(rma_numbers) ? rma_numbers.map(String) : null,
      shared ? { ctx: shared.ctx, ledgers: shared.ledgers, items: shared.items } : null);
    if (expectedCompany && p.company !== expectedCompany) return [409, { error: `Tally's open company changed to "${p.company}". Check it is the right one, then try again.` }];
    if (p.problems.length || !p.note) return [422, { error: 'cannot post', problems: p.problems, warnings: p.warnings }];
    if (!p.voucher_date) return [422, { error: 'no received date in RMS for these items' }];
    // Re-read the open company right before writing: a batch runs for minutes and the operator can
    // switch companies in Tally meanwhile. Nothing is posted into a company other than the expected one.
    const nowCompany = await activeCompany();
    if (nowCompany !== p.company || (expectedCompany && nowCompany !== expectedCompany)) {
      return [409, { error: `Tally's open company changed to "${nowCompany || 'none'}". Check it is the right one, then try again.` }];
    }

    const voucher = cn.buildCreditNoteVoucher({ voucherNumber: p.voucher_number, date: p.voucher_date, orderNo: p.order_no, note: p.note });
    let response;
    try { response = await importVouchers([voucher]); }
    catch (err) { return [502, { error: `Tally import failed: ${err.message}` }]; }

    // The read-back is the proof; a clean import response is not.
    const back = await readCreditNote(cn.VOUCHER_TYPE, p.voucher_number, p.voucher_date.replace(/-/g, ''));
    if (!back || back.duplicates) {
      const errs = response?.error_list?.join('; ') || (response?.data?.import_result ? JSON.stringify(response.data.import_result) : '');
      return [502, { error: back?.duplicates ? `${back.duplicates} vouchers numbered ${p.voucher_number} on that date — check Tally` : `the credit note is not in Tally after import${errs ? `: ${errs}` : ''}` }];
    }
    const partyLine = back.ledgers.find((l) => l.ledger === p.note.party_ledger);
    const checks = [];
    if (back.party !== p.note.party_ledger) checks.push(`party is "${back.party}"`);
    if (!partyLine || Math.abs(Math.abs(partyLine.amount) - p.note.party_amount) > 0.01) checks.push(`party amount is ${partyLine ? Math.abs(partyLine.amount) : 'missing'}, expected ${p.note.party_amount}`);
    if (back.items.length !== p.note.lines.length) checks.push(`${back.items.length} item line(s), expected ${p.note.lines.length}`);
    if (back.countryOfResidence !== 'India' || back.consigneeCountry !== 'India') checks.push('country is not India on both fields');
    const warnings = [...p.warnings];
    if (back.natureOfReturn !== cn.REASON) warnings.push(`reason for issuing note reads "${back.natureOfReturn || 'empty'}" in Tally`);
    if (/error/i.test(back.statusBeforeCreate)) warnings.push('Tally marked this voucher "Error" when it was created — open it in Tally and check');

    const id = cnStore.insertCreditNote({
      voucher_number: p.voucher_number, voucher_date: p.voucher_date, company: p.company, order_no: p.order_no,
      party: p.note.party_ledger, invoice_no: p.note.invoice_no, amount: p.note.party_amount,
      note: { ...p.note, warnings, checks }, rma_numbers: p.selected, test_mode: testMode,
    });
    cnBusy = false;   // Tally work is done; the RMS call below does not touch the gateway
    if (checks.length) {
      cnStore.markSynced(id, false, `posted, but the read-back differs: ${checks.join('; ')}`);
      return [200, { created: true, id, voucherNumber: p.voucher_number, company: p.company, checks, warnings, rms: { synced: false, error: 'not sent: the read-back differs — check the credit note in Tally first' } }];
    }
    if (testMode) {
      cnStore.markSynced(id, false, 'test posting — RMS not updated');
      return [200, { created: true, id, voucherNumber: p.voucher_number, company: p.company, warnings, amount: p.note.party_amount, rms: { synced: false, test: true } }];
    }
    const sync = await cnSyncToRms(id, p.voucher_number, p.voucher_date, p.selected);
    return [200, { created: true, id, voucherNumber: p.voucher_number, company: p.company, warnings, amount: p.note.party_amount, rms: sync }];
  } catch (err) {
    return [err.status || 500, { error: err.message }];
  } finally {
    cnBusy = false;
  }
}

// --- Batch build and batch create (the Material Out pattern) ------------------------------------
// Fetch = one server job that prepares EVERY order of the date range: RMS + Unicommerce, then Tally
// (numbers, existing credit notes, ledgers, stock items) read once for the whole batch. The screen then
// shows the finished report and nothing loads while ticking. Create = one server job that posts the
// ticked orders one at a time; each is re-checked against Tally (fresh RMS data, existing notes,
// numbers no older than a minute, and the open company) just before it is written.
let cnReport = null;       // { builtAt, from, to, company, rows, counts, totals, truncated }
let cnMasters = null;      // the ledgers and stock items the last build found in Tally (reused by create)
let cnJob = null;          // { type: 'build' | 'create', running, done, total, message, error, result }
let cnStopAsked = false;

const cnAlreadyCredited = (problems) => problems.length > 0 && problems.every((x) => /already credited/.test(x));
const cnStatusOf = (p) => (p.error ? 'error' : !p.problems.length && p.note ? 'ready' : p.existing?.length && cnAlreadyCredited(p.problems) ? 'intally' : 'blocked');
function cnCount(rows) {
  const counts = { all: rows.length, ready: 0, intally: 0, blocked: 0, error: 0, done: 0, failed: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const readyAmount = rows.filter((r) => r.status === 'ready').reduce((s, r) => s + (r.note?.party_amount || 0), 0);
  return { counts, totals: { readyAmount: Math.round(readyAmount * 100) / 100 } };
}

async function cnBuild(from, to) {
  const t0 = Date.now();
  cnJob = { type: 'build', running: true, done: 0, total: 0, message: 'Reading Good Returns without a credit note from RMS…', error: '' };
  try {
    const pend = await rms.cnPending(from, to);
    const orders = pend.orders.filter((o) => o.order_no);
    cnJob.total = orders.length;
    cnJob.message = 'Fetching each order from RMS and Unicommerce…';

    // RMS / Unicommerce, a few at a time — these calls never touch Tally.
    const rmsData = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < orders.length) {
        const o = orders[next++];
        try { rmsData.set(o.order_no, await rms.cnOrder(o.order_no)); } catch (err) { rmsData.set(o.order_no, err); }
        cnJob.done++;
      }
    }));

    // Tally, once for the whole batch, one request at a time.
    cnJob.message = 'Checking every order against Tally (numbers, existing credit notes, ledgers, items)…';
    cnBusy = true;
    let ctx, rows = [];
    try {
      ctx = await cnTallyContext();
      const okOrders = orders.filter((o) => !(rmsData.get(o.order_no) instanceof Error)).map((o) => rmsData.get(o.order_no));
      const existing = await cnExistingFor(okOrders.map((d) => d.order_no), ctx);
      itemNamesCache = { at: 0, names: null };                 // fresh item list for a new build
      const items = await stockItemNames();
      // Every ledger any of these credit notes would use, found in a few lookups instead of one per order.
      const want = new Set([cn.COD_LEDGER]);
      for (const d of okOrders) {
        const r = cn.computeCreditNote({ rows: d.rows.filter((x) => !x.credit_note_no), uc: d.unicommerce, ...cnCredited(existing.get(d.order_no) || [], d) });
        if (r.note) for (const l of [r.note.party_ledger, ...r.note.lines.map((x) => x.ledger), ...r.note.tax.map((x) => x.ledger)]) want.add(l);
      }
      const names = [...want].filter(Boolean), ledgers = new Set();
      for (let i = 0; i < names.length; i += 150) for (const n of await existingLedgers(names.slice(i, i + 150))) ledgers.add(n);
      cnMasters = { ledgers, items };

      for (const o of orders) {
        const d = rmsData.get(o.order_no);
        let p;
        if (d instanceof Error) p = { order_no: o.order_no, error: `RMS: ${d.message}`, problems: [], warnings: [] };
        else {
          try { p = await cnPrepare(o.order_no, null, { rms: d, ctx, existing: existing.get(d.order_no) || [], ledgers, items }); }
          catch (err) { p = { order_no: o.order_no, error: err.message, problems: [], warnings: [] }; }
        }
        rows.push({
          ...p, status: cnStatusOf(p),
          customer_name: o.customer_name, customer_email: o.customer_email, invoice_no: o.invoice_no,
          first_received_date: o.first_received_date, rms_items: o.items,
        });
      }
    } finally { cnBusy = false; }

    cnReport = { builtAt: new Date().toISOString(), from, to, company: ctx.company, rows, truncated: Boolean(pend.truncated), ...cnCount(rows) };
    const c = cnReport.counts;
    cnJob = { type: 'build', running: false, error: '',
      message: `Built in ${Math.round((Date.now() - t0) / 1000)} s — ${c.ready} ready, ${c.intally} already in Tally, ${c.blocked + c.error} blocked${pend.truncated ? ' (more than 3,000 returns: narrow the dates)' : ''}.` };
  } catch (err) {
    cnBusy = false;
    cnJob = { type: 'build', running: false, message: '', error: err.message };
  }
}

async function cnCreateBatch(orderNos, testMode) {
  const company = cnReport.company;
  const byOrder = new Map(cnReport.rows.map((r) => [r.order_no, r]));
  const list = orderNos.map((o) => byOrder.get(o)).filter((r) => r && r.status === 'ready');
  cnStopAsked = false;
  cnJob = { type: 'create', running: true, done: 0, total: list.length, message: 'Posting credit notes…', error: '' };
  const result = { created: 0, failed: 0, skipped: 0, rmsMissed: 0, stopped: false, company, testMode };
  let shared = null, sharedAt = 0;
  try {
    // Masters found by the build (a ledger it did not see is still looked up); the numbers are re-read
    // whenever they are more than a minute old.
    shared = { ledgers: cnMasters?.ledgers || new Set(), items: cnMasters?.items || null };
    if (!shared.items) { cnBusy = true; try { shared.items = await stockItemNames(); } finally { cnBusy = false; } }
    for (const row of list) {
      if (cnStopAsked) { result.stopped = true; break; }
      if (!shared.ctx || Date.now() - sharedAt > 60000) {
        cnBusy = true;
        try { shared.ctx = await cnTallyContext(); sharedAt = Date.now(); } finally { cnBusy = false; }
      }
      cnJob.message = `Posting ${cnJob.done + 1} of ${list.length}: order ${row.order_no}…`;
      row.status = 'posting';
      const [code, res] = await cnCreate({ order_no: row.order_no, rma_numbers: row.selected, expectedCompany: company, testMode }, { inJob: true, shared });
      if (code === 200 && res.created) {
        result.created++;
        shared.ctx.grNos.add(res.voucherNumber); shared.ctx.allNos.add(res.voucherNumber);
        const rmsOk = Boolean(res.rms?.synced || res.rms?.test) && !res.checks?.length;
        if (!rmsOk) result.rmsMissed++;
        Object.assign(row, { status: 'done', created: { voucherNumber: res.voucherNumber, id: res.id, rmsOk,
          rmsText: res.checks?.length ? `read-back differs: ${res.checks.join('; ')} — check in Tally; RMS not updated`
            : res.rms?.test ? 'test — RMS not updated' : res.rms?.synced ? 'RMS updated' : `RMS NOT updated: ${res.rms?.error} — retry from History` } });
      } else if (cnAlreadyCredited(res.problems || [])) {
        result.skipped++;
        Object.assign(row, { status: 'intally', problems: res.problems });   // credited elsewhere since Fetch: nothing written
      } else {
        result.failed++;
        Object.assign(row, { status: 'failed', failure: res.problems?.length ? res.problems.join(' · ') : (res.error || 'post failed') });
        if (/company changed/i.test(res.error || '')) { result.stopped = true; result.companyChanged = res.error; break; }
      }
      cnJob.done++;
    }
  } catch (err) {
    cnJob.error = err.message;
  } finally {
    for (const r of cnReport.rows) if (r.status === 'posting') r.status = 'ready';
    Object.assign(cnReport, cnCount(cnReport.rows));
    const left = list.filter((r) => r.status === 'ready').length;
    cnJob = { type: 'create', running: false, done: cnJob.done, total: list.length, error: cnJob.error || result.companyChanged || '', result,
      message: `Created ${result.created} credit note(s) in ${company}${testMode ? ' (TEST — RMS not updated)' : ''}.`
        + (result.failed ? ` ${result.failed} not posted.` : '') + (result.skipped ? ` ${result.skipped} already credited elsewhere.` : '')
        + (result.rmsMissed && !testMode ? ` RMS not updated for ${result.rmsMissed} — retry from History.` : '') + (left ? ` ${left} not attempted (stopped).` : '') };
  }
}

async function handleCreditNote(url, req, res) {
  const p = url.pathname.slice('/api/cn'.length);
  const q = (k) => url.searchParams.get(k) || '';

  // Fetch: build the whole report in the background; the screen follows it through /api/state.
  if (p === '/build' && req.method === 'POST') {
    const { from, to } = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) return json(res, 400, { error: 'pick a received-date range (from ≤ to)' });
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    cnBuild(from, to);
    return json(res, 202, { started: true });
  }
  // The finished report: every order with its credit note, problems and status (read once by the screen).
  if (p === '/rows') return json(res, 200, cnReport ? { ...cnReport } : { rows: [] });
  // The same report as an Excel workbook (from memory; Tally is not asked anything).
  if (p === '/excel') {
    if (!cnReport) return json(res, 409, { error: 'press Fetch first' });
    const buffer = await creditNoteReportToXlsx(cnReport);
    const range = cnReport.from === cnReport.to ? cnReport.from : `${cnReport.from}-to-${cnReport.to}`;
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="credit-notes-${range}.xlsx"`,
    });
    return res.end(Buffer.from(buffer));
  }
  // Create the ticked orders (one at a time, each re-checked) in the background.
  if (p === '/create-batch' && req.method === 'POST') {
    const { orders, testMode } = await readBody(req);
    if (!cnReport) return json(res, 409, { error: 'press Fetch first' });
    if (!Array.isArray(orders) || !orders.length) return json(res, 400, { error: 'tick at least one ready order' });
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    cnBusy = true;
    let company;
    try { company = await activeCompany(); } finally { cnBusy = false; }
    if (company !== cnReport.company) return json(res, 409, { error: `The report was built in "${cnReport.company}" but Tally now has "${company || 'no company'}" open — press Fetch again.` });
    cnCreateBatch(orders.map(String), testMode === true);
    return json(res, 202, { started: true });
  }
  if (p === '/stop' && req.method === 'POST') { cnStopAsked = true; return json(res, 200, { stopping: true }); }

  if (p === '/pending') {   // RMS only — safe while Tally is busy
    try { return json(res, 200, await rms.cnPending(q('from'), q('to'))); }
    catch (err) { return json(res, err.status || 502, { error: err.message }); }
  }
  if (p === '/preview') {
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    cnBusy = true;
    try {
      const rmas = q('rmas') ? q('rmas').split(',').filter(Boolean) : null;
      return json(res, 200, await cnPrepare(q('order'), rmas));
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    } finally { cnBusy = false; }
  }
  if (p === '/create' && req.method === 'POST') {
    const [code, body] = await cnCreate(await readBody(req));
    return json(res, code, body);
  }
  if (p === '/history') return json(res, 200, { rows: cnStore.listCreditNotes({ q: q('q'), from: q('from'), to: q('to'), limit: q('limit') || 200 }) });
  if (p === '/note') {
    const n = cnStore.getCreditNote(Number(q('id')));
    return n ? json(res, 200, n) : json(res, 404, { error: 'credit note not found' });
  }
  if (p === '/resync' && req.method === 'POST') {
    const { id } = await readBody(req);
    const n = cnStore.getCreditNote(Number(id));
    if (!n) return json(res, 404, { error: 'credit note not found' });
    if (n.test_mode) return json(res, 409, { synced: false, error: 'test posting — RMS is never updated for it' });
    if (n.note?.checks?.length) return json(res, 409, { synced: false, error: 'the read-back differed — check the credit note in Tally before updating RMS' });
    return json(res, 200, await cnSyncToRms(n.id, n.voucher_number, n.voucher_date, n.rma_numbers));
  }
  return json(res, 404, { error: 'not found' });
}

// --- Unicommerce Sales -----------------------------------------------------------------------
// Unicommerce's "Tally GST Report 3.0" export supplies the sales; lib/ucsales.mjs does the accounting
// (verified field-for-field against 518 real, already-posted Oct-10 Sales vouchers); Tally is checked
// before and read back after posting, same discipline as Credit Note.
//
// One difference from Credit Note: the party (customer email) ledger is allowed to not exist yet — a
// new customer is normal here, not an error — so it is created on the spot (lib/tally.mjs
// importMasters, NOT yet proven the way voucher import is; the read-back after posting is what proves
// it worked, every time, not just the first time).

// Normalizes both whitespace runs AND spacing around hyphens, so "Klipsch - The Fives" (Unicommerce)
// and "Klipsch-The Fives" (Tally) compare equal — confirmed as the same product, 2026-10-15.
const itemKey = (name) => String(name || '').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

// Cheap: ping + which company is open. Does NOT touch voucher data — safe to call on every loop
// iteration of a batch, unlike the duplicate-number check below.
async function ucTallyContext() {
  if (!(await ping())) throw Object.assign(new Error('Tally is not running'), { status: 503 });
  const company = await activeCompany();
  if (!company) throw Object.assign(new Error('Tally is running but no company is open'), { status: 503 });
  await periodGuard(gst.istToday());
  return { company };
}

// Tally hides every voucher outside the open company's CURRENT PERIOD (Alt+F2) from every request. If the
// period stops short, a duplicate check sees nothing and treats posted documents as missing — on
// 2026-10-22 Tally was reopened with the period ending 30-Sep and the COD check took 309 posted AWBs for
// unposted. So any job that needs dates up to `needIso` is refused until the period reaches it.
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymdText = (y) => `${+y.slice(6, 8)}-${MON3[+y.slice(4, 6) - 1]}-${y.slice(0, 4)}`;
async function periodGuard(needIso) {
  const need = String(needIso).replace(/-/g, '');
  const p = await companyPeriod();
  if (p?.to && p.to < need) {
    throw Object.assign(new Error(`Tally's current period ends ${ymdText(p.to)}, so Tally hides every entry after that date. `
      + `In Tally press Alt+F2 (Change Period), set it to 1-4-${p.from ? p.from.slice(0, 4) : '2026'} to 31-3-${p.from ? +p.from.slice(0, 4) + 1 : '2027'}, then try again.`), { status: 409 });
  }
}

const ymd8 = (yyyy_mm_dd) => String(yyyy_mm_dd).replace(/-/g, '');

// Invoice numbers already in Tally, for duplicate detection: number -> { cancelled, type, date }.
// Deliberately scoped by typed date range — Sales holds far more volume than Credit Note, and the
// unscoped all-time walk timed out Tally when this was tried. Three things it guards against:
//   - a voucher CANCELLED in Tally keeps its number and is listed here (flag cancelled), so a
//     cancelled invoice is never imported again (verified 15-16 Oct 2026: 7 of 7 cancelled found);
//   - every Sales-class type is read (Sales, UniCommerce Sales…), not just the one this tab posts;
//   - the window is widened by TAKEN_MARGIN_DAYS each side, so an invoice Tally dated a day or two
//     off from Unicommerce is still seen as taken, not posted a second time.
const TAKEN_MARGIN_DAYS = 3;
async function ucTakenNumbers(company, from, to) {
  const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const taken = new Map();
  for (const v of await salesNumbersInRange(ymd8(shift(from, -TAKEN_MARGIN_DAYS)), ymd8(shift(to, TAKEN_MARGIN_DAYS)))) {
    // A number on two vouchers (cancelled + re-entered) counts as live if any copy is live.
    const prev = taken.get(v.no);
    taken.set(v.no, { cancelled: v.cancelled && (!prev || prev.cancelled), type: v.type, date: v.date });
  }
  for (const n of ucStore.issuedNumbers(company)) if (!taken.has(n)) taken.set(n, { cancelled: false, type: 'posted from this app', date: null });
  return taken;
}

// Checks one order against Tally masters (sales/tax/charge ledgers and stock items must already exist;
// the party ledger does not — see module note above). `known` lets a batch share lookups it already did.
async function ucCheckMasters(note, known) {
  const problems = [];
  const needLedgers = [...new Set([...note.lines.map((l) => l.ledger), ...note.tax.map((t) => t.ledger), ...note.charges.map((c) => c.ledger)])];
  const haveLedgers = known?.ledgers || new Set();
  const unknownLedgers = needLedgers.filter((l) => !haveLedgers.has(l));
  const foundLedgers = new Set([...haveLedgers, ...(unknownLedgers.length ? await existingLedgers(unknownLedgers) : [])]);
  for (const l of needLedgers) if (!foundLedgers.has(l)) problems.push(`ledger "${l}" not found in Tally`);

  // Deliberately NOT falling back to "Unboxed - <name>" when the bare name has no match: whether a
  // unit is unboxed is a fact about what was actually sold (it shows up in Unicommerce's own Product
  // Name when it applies, e.g. "Unboxed - FiiO - JT1 - Black..."), not something to infer from what
  // Tally happens to have in stock. Substituting it silently would post against the wrong physical
  // inventory. A name with no match — boxed or unboxed — stays blocked (2026-10-15 correction).
  const items = known?.items || new Set(await listStockItemNames());
  const byKey = new Map([...items].map((n) => [itemKey(n), n]));
  for (const l of note.lines) {
    const exact = items.has(l.item) ? l.item : byKey.get(itemKey(l.item));
    if (exact) l.item = exact; // post under Tally's own spelling
    else problems.push(`stock item "${l.item}" not found in Tally (name not matched)`);
  }
  return { problems, ledgers: foundLedgers, items };
}

async function ucPrepare(order, { ctx, taken, known } = {}) {
  const computed = ucsales.computeSalesOrder(order);
  const problems = [...computed.problems], warnings = [...computed.warnings];
  const context = ctx || await ucTallyContext();
  const alreadyPosted = taken.has(order.invoice);
  let masters = null;
  if (computed.ok && !alreadyPosted) {
    masters = await ucCheckMasters(computed.note, known);
    problems.push(...masters.problems);
  }
  return {
    invoice: order.invoice, sale_order_number: computed.note?.sale_order_number || order.saleOrderNumber,
    customer_name: order.customerName, customer_email: order.customerEmail, date: order.date,
    payment_method: order.paymentMethod, rows: order.rows,
    company: context.company, already_posted: alreadyPosted,
    tally_cancelled: alreadyPosted ? Boolean(taken.get(order.invoice)?.cancelled) : false,
    note: computed.ok ? computed.note : null, problems, warnings,
    masters: masters ? { ledgers: masters.ledgers, items: masters.items } : null,
  };
}

const ucStatusOf = (p) => (p.error ? 'error' : p.already_posted ? 'intally' : !p.problems.length && p.note ? 'ready' : 'blocked');
function ucCount(rows) {
  const counts = { all: rows.length, ready: 0, intally: 0, blocked: 0, error: 0, done: 0, failed: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const readyAmount = rows.filter((r) => r.status === 'ready').reduce((s, r) => s + (r.note?.party_amount || 0), 0);
  return { counts, totals: { readyAmount: Math.round(readyAmount * 100) / 100 } };
}

let ucReport = null;     // { builtAt, from, to, company, rows, counts, totals }
let ucMasters = null;    // ledgers/items the last build found (reused by create)
let ucJob = null;        // { type: 'build' | 'create', running, done, total, message, error, result }
let ucStopAsked = false;

async function ucBuild(from, to) {
  const t0 = Date.now();
  ucJob = { type: 'build', running: true, done: 0, total: 0, message: 'Pulling the Unicommerce sales report…', error: '' };
  try {
    const { orders, rowCount } = await uc.fetchSalesReport(from, to);
    ucJob.total = orders.length;
    ucJob.message = `Checking ${orders.length} order(s) against Tally (numbers, ledgers, items)…`;
    ucBusy = true;
    let ctx, rows = [];
    try {
      ctx = await ucTallyContext();
      const taken = await ucTakenNumbers(ctx.company, from, to);
      const items = new Set(await listStockItemNames());
      const want = new Set();
      for (const o of orders) {
        const c = ucsales.computeSalesOrder(o);
        if (c.ok) for (const l of [...c.note.lines.map((x) => x.ledger), ...c.note.tax.map((x) => x.ledger), ...c.note.charges.map((x) => x.ledger)]) want.add(l);
      }
      const names = [...want], ledgers = new Set();
      for (let i = 0; i < names.length; i += 150) for (const n of await existingLedgers(names.slice(i, i + 150))) ledgers.add(n);
      ucMasters = { ledgers, items };
      for (const o of orders) {
        const p = await ucPrepare(o, { ctx, taken, known: ucMasters });
        rows.push({ ...p, status: ucStatusOf(p) });
        ucJob.done++;
      }
    } finally { ucBusy = false; }
    ucReport = { builtAt: new Date().toISOString(), from, to, company: ctx.company, rowCount, rows, ...ucCount(rows) };
    const c = ucReport.counts;
    ucJob = { type: 'build', running: false, error: '',
      message: `Built in ${Math.round((Date.now() - t0) / 1000)} s — ${rowCount} line(s) across ${c.all} order(s): ${c.ready} ready, ${c.intally} already in Tally, ${c.blocked} blocked.` };
  } catch (err) {
    ucBusy = false;
    ucJob = { type: 'build', running: false, message: '', error: err.message };
  }
}

// order.date ("DD-MM-YYYY") -> Tally's YYYYMMDD.
function ucTallyDate(ddmmyyyy) {
  const dm = String(ddmmyyyy || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return dm ? `${dm[3]}${dm[2]}${dm[1]}` : null;
}

// Batch size for both the import call and the read-back call. Conservative: each voucher's JSON can
// run a few KB with several items, and this has not yet been measured at scale against this gateway
// the way the read-only recipes in the TDL skill's new reference doc have been. Tune after a real run.
const UC_BATCH_SIZE = 40;
// How often (ms) to re-confirm the open company hasn't changed mid-run. A full check, not per voucher.
const UC_COMPANY_CHECK_INTERVAL = 15000;

async function ucCreateBatch(invoices, testMode) {
  const byInvoice = new Map(ucReport.rows.map((r) => [r.invoice, r]));
  const list = invoices.map((i) => byInvoice.get(i)).filter((r) => r && r.status === 'ready');
  const company = ucReport.company;
  ucStopAsked = false;
  ucJob = { type: 'create', running: true, done: 0, total: list.length, message: 'Preparing to post…', error: '' };
  const result = { created: 0, failed: 0, stopped: false, company, testMode };
  try {
    ucBusy = true;

    // 1) Fresh duplicate check across the whole set in one scoped call, not one per voucher.
    const taken = await ucTakenNumbers(company, ucReport.from, ucReport.to);
    const toPost = [];
    for (const r of list) {
      if (taken.has(r.invoice)) { r.status = 'intally'; r.tally_cancelled = taken.get(r.invoice).cancelled; continue; }
      const d = ucTallyDate(r.date);
      if (!d) { r.status = 'failed'; r.failure = `unrecognised date "${r.date}"`; result.failed++; continue; }
      r._tallyDate = d;
      toPost.push(r);
    }

    // 2) Customer ledgers: check which of the distinct emails already exist (chunked — existingLedgers
    // builds one big OR formula and does not chunk internally), then batch-create whatever is missing,
    // then prove it with a batched re-check. Never trust the import response alone.
    ucJob.message = `Checking customer ledgers for ${toPost.length} order(s)…`;
    const emails = [...new Set(toPost.map((r) => r.note.customer_email))];
    // Case-insensitive, done in JS against the full ledger list (see allLedgerNamesByLower) — not a
    // Tally-side filter. Corrects each order's party name to Tally's actual casing before anything is
    // built or posted, so the voucher's party reference matches exactly.
    const ciMap = await allLedgerNamesByLower();
    for (const r of toPost) {
      const real = ciMap.get(r.note.customer_email.toLowerCase());
      if (real && real !== r.note.customer_email) r.note.customer_email = real;
    }
    const missingEmails = emails.filter((e) => !ciMap.has(e.toLowerCase()));
    if (missingEmails.length) {
      ucJob.message = `Creating ${missingEmails.length} new customer ledger(s)…`;
      const byEmail = new Map(toPost.map((r) => [r.note.customer_email, r]));
      for (let i = 0; i < missingEmails.length; i += 50) {
        const chunk = missingEmails.slice(i, i + 50).map((email) => {
          const r = byEmail.get(email), n = r.note;
          return ucsales.buildCustomerLedger({ email, name: n.customer_name, mobile: n.customer_mobile, state: n.billing_state, addressLines: n.billing_address, gstin: n.customer_gstin, gstRegistrationType: n.gst_registration_type, dateYmd: r._tallyDate });
        });
        await importMasters(chunk);
      }
      const confirmed = new Set();
      for (let i = 0; i < missingEmails.length; i += 150) for (const n of await existingLedgers(missingEmails.slice(i, i + 150))) confirmed.add(n);
      const stillMissing = new Set(missingEmails.filter((e) => !confirmed.has(e)));
      if (stillMissing.size) {
        for (let i = toPost.length - 1; i >= 0; i--) {
          if (stillMissing.has(toPost[i].note.customer_email)) {
            toPost[i].status = 'failed'; toPost[i].failure = `customer ledger "${toPost[i].note.customer_email}" could not be created`;
            result.failed++; toPost.splice(i, 1);
          }
        }
      }
    }

    // 2b) Deliberately removed (2026-10-16): existing customer ledgers are left exactly as they are,
    // even when an order's address differs from what's on file. No alter, no new address entry.

    // 3) Post and verify in batches.
    ucJob.total = toPost.length;
    let lastCompanyCheck = 0;
    for (let i = 0; i < toPost.length; i += UC_BATCH_SIZE) {
      if (ucStopAsked) { result.stopped = true; break; }
      if (Date.now() - lastCompanyCheck > UC_COMPANY_CHECK_INTERVAL) {
        const fresh = await ucTallyContext();
        if (fresh.company !== company) { result.stopped = true; result.companyChanged = `Tally's open company changed to "${fresh.company}". Check it is the right one, then try again.`; break; }
        lastCompanyCheck = Date.now();
      }
      const batch = toPost.slice(i, i + UC_BATCH_SIZE);
      for (const r of batch) r.status = 'posting';
      ucJob.message = `Posting ${i + 1}-${Math.min(i + UC_BATCH_SIZE, toPost.length)} of ${toPost.length}…`;

      const vouchers = batch.map((r) => ucsales.buildSalesVoucher({ voucherNumber: r.invoice, date: r._tallyDate, note: r.note }));
      try { await importVouchers(vouchers); }
      catch (err) {
        for (const r of batch) { r.status = 'failed'; r.failure = `Tally import failed: ${err.message}`; result.failed++; }
        ucJob.done += batch.length;
        continue;
      }

      // Batched read-back, scoped to the report's date range, <=200 numbers per call.
      const numbers = batch.map((r) => r.invoice);
      const backByNumber = new Map();
      for (let j = 0; j < numbers.length; j += 200) {
        for (const v of await readSalesVouchersBatch(numbers.slice(j, j + 200), ucReport.from.replace(/-/g, ''), ucReport.to.replace(/-/g, ''))) {
          backByNumber.set(v.voucherNumber, backByNumber.has(v.voucherNumber) ? 'DUPLICATE' : v);
        }
      }

      for (const r of batch) {
        const back = backByNumber.get(r.invoice);
        if (!back || back === 'DUPLICATE') {
          r.status = 'failed'; r.failure = back === 'DUPLICATE' ? 'multiple vouchers with this number — check Tally' : 'not found in Tally after import';
          result.failed++; continue;
        }
        const partyLine = back.ledgers.find((l) => l.ledger === r.note.customer_email);
        const checks = [];
        if (back.party !== r.note.customer_email) checks.push(`party is "${back.party}"`);
        if (!partyLine || Math.abs(Math.abs(partyLine.amount) - r.note.party_amount) > 0.02) checks.push(`party amount is ${partyLine ? Math.abs(partyLine.amount) : 'missing'}, expected ${r.note.party_amount}`);
        if (back.items.length !== r.note.lines.length) checks.push(`${back.items.length} item line(s), expected ${r.note.lines.length}`);

        const id = ucStore.insertSale({
          voucher_number: r.invoice, voucher_date: `${r._tallyDate.slice(0, 4)}-${r._tallyDate.slice(4, 6)}-${r._tallyDate.slice(6, 8)}`, company,
          sale_order_no: r.note.sale_order_number, customer_email: r.note.customer_email, amount: r.note.party_amount,
          note: { ...r.note, checks }, test_mode: testMode,
        });
        result.created++;
        taken.set(r.invoice, { cancelled: false, type: ucsales.VOUCHER_TYPE, date: r._tallyDate });   // ucTakenNumbers returns a Map
        r.status = 'done'; r.created = { voucherNumber: r.invoice, id, checks };
      }
      ucJob.done += batch.length;
    }
  } catch (err) {
    ucJob.error = err.message;
  } finally {
    ucBusy = false;
    for (const r of ucReport.rows) if (r.status === 'posting') r.status = 'ready';
    Object.assign(ucReport, ucCount(ucReport.rows));
    const left = list.filter((r) => r.status === 'ready').length;
    ucJob = { type: 'create', running: false, done: ucJob.done, total: ucJob.total || list.length, error: ucJob.error || result.companyChanged || '', result,
      message: `Created ${result.created} Sales voucher(s) in ${company}${testMode ? ' (TEST)' : ''}.`
        + (result.failed ? ` ${result.failed} not posted.` : '') + (left ? ` ${left} not attempted (stopped).` : '')
        };
  }
}

async function handleUcSales(url, req, res) {
  const p = url.pathname.slice('/api/uc'.length);
  const q = (k) => url.searchParams.get(k) || '';

  if (p === '/build' && req.method === 'POST') {
    const { from, to } = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) return json(res, 400, { error: 'pick a date range (from ≤ to)' });
    if (!uc.configured()) return json(res, 409, { error: 'Unicommerce is not configured — set UNICOMMERCE_* in .env' });
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    ucBuild(from, to);
    return json(res, 202, { started: true });
  }
  if (p === '/rows') return json(res, 200, ucReport ? { ...ucReport } : { rows: [] });
  if (p === '/create-batch' && req.method === 'POST') {
    const { invoices, testMode } = await readBody(req);
    if (!ucReport) return json(res, 409, { error: 'press Fetch first' });
    if (!Array.isArray(invoices) || !invoices.length) return json(res, 400, { error: 'tick at least one ready order' });
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    ucBusy = true;
    let company;
    try { company = await activeCompany(); } finally { ucBusy = false; }
    if (company !== ucReport.company) return json(res, 409, { error: `The report was built in "${ucReport.company}" but Tally now has "${company || 'no company'}" open — press Fetch again.` });
    ucCreateBatch(invoices.map(String), testMode === true);
    return json(res, 202, { started: true });
  }
  if (p === '/stop' && req.method === 'POST') { ucStopAsked = true; return json(res, 200, { stopping: true }); }
  if (p === '/history') return json(res, 200, { rows: ucStore.listSales({ q: q('q'), from: q('from'), to: q('to'), limit: q('limit') || 200 }) });
  if (p === '/note') {
    const n = ucStore.getSale(Number(q('id')));
    return n ? json(res, 200, n) : json(res, 404, { error: 'sale not found' });
  }
  return json(res, 404, { error: 'not found' });
}

// --- E-Way Bill / E-Invoice ----------------------------------------------------------------------
// Fetch reads the range's Sales vouchers from Tally (one day per request), then closed / returned /
// portal status from Supabase. Close and the list never touch Tally; Check portal does (it re-reads
// the invoice days of the portal bills), so it runs as a job holding the Tally-busy flag.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const gstSummary = (r) => r && { builtAt: r.builtAt, from: r.from, to: r.to, company: r.company, counts: r.counts,
  missingCounts: r.missingCounts, warnings: r.warnings, portalDays: r.portalDays || null };

async function gstBuild(kind, from, to) {
  const t0 = Date.now();
  const days = gst.isoDays(from, to);
  gstJob[kind] = { type: 'build', running: true, done: 0, total: days.length, message: 'Reading sales vouchers from Tally…', error: '' };
  try {
    const company = await activeCompany();
    if (!company) throw new Error('No company is open in Tally.');
    const vouchers = await gst.readTally(days, (done) => {
      gstJob[kind].done = done;
      gstJob[kind].message = `Reading sales vouchers from Tally — day ${done} of ${days.length}…`;
    });
    gstJob[kind].message = 'Checking closed, returned and portal status in Supabase…';
    const r = gstReport[kind] = await gst.buildReport(kind, from, to, vouchers, company);
    const { label } = gst.KINDS[kind];
    gstJob[kind] = { type: 'build', running: false, error: '',
      message: `Fetched in ${Math.round((Date.now() - t0) / 1000)} s — ${r.vouchersRead} sales vouchers read: `
        + `${r.counts.all} ${label}(s), ${r.counts.pending} open (${r.counts.overdue} overdue), ${r.missingCounts.missing} missing.` };
  } catch (err) {
    gstJob[kind] = { type: 'build', running: false, message: '', error: err.message };
  }
}

async function gstPortal(from, to) {
  gstJob.ewb = { type: 'portal', running: true, done: 0, total: 0, message: 'Checking the GSP portal…', error: '' };
  try {
    const result = await gst.portalCheck(from, to, {
      readDays: (days) => gst.readTally(days),
      onProgress: (message) => { gstJob.ewb.message = message; },
    });
    if (gstReport.ewb) await gst.enrich(gstReport.ewb);   // show the saved results on the list (Supabase only)
    const c = result.calls;
    const bits = [`${result.bills} e-Way Bill(s) on the portal`,
      result.notInTally ? `${result.notInTally} NOT in Tally: ${result.notInTallyList.join(', ')}` : 'every one of them is in Tally',
      `${c.thisCheck} paid GSP call(s) this check (${c.today} today, ${c.total} in total)`];
    const empty = result.perDay.filter((d) => d.note);
    if (empty.length) bits.push(`no list for ${empty.map((d) => `${d.date} (${d.note})`).join(', ')}`);
    gstJob.ewb = { type: 'portal', running: false, error: '', result, message: `Portal check: ${bits.join(' — ')}.` };
  } catch (err) {
    if (gstReport.ewb) await gst.enrich(gstReport.ewb).catch(() => {});   // days pulled before a failure are saved
    gstJob.ewb = { type: 'portal', running: false, message: '', error: `Portal check failed: ${err.message}` };
  }
}

// Scheduled BlueDart check. Every BLUEDART_AUTO_MINUTES (30): read the last BLUEDART_AUTO_DAYS (14) of
// Sales vouchers from Tally (~1.6 s a day), and close every open e-Way Bill / e-Invoice whose AWB the
// BlueDart manifest shows dispatched. Never overlaps another Tally job: if Tally is busy it tries again
// a minute later. Tally closed or no company open -> skipped until the next round.
const AUTO_MINUTES = Math.max(5, Number(process.env.BLUEDART_AUTO_MINUTES) || 30);
const AUTO_DAYS = Math.min(gst.MAX_DAYS, Math.max(1, Number(process.env.BLUEDART_AUTO_DAYS) || 14));
const gstAuto = { everyMinutes: AUTO_MINUTES, days: AUTO_DAYS, lastRun: null, result: null, error: null,
  nextRun: Date.now() + 2 * 60e3 };

async function gstAutoTick() {
  if (gstAutoBusy || Date.now() < gstAuto.nextRun) return;
  const later = () => { gstAuto.lastRun = new Date().toISOString(); gstAuto.nextRun = Date.now() + AUTO_MINUTES * 60e3; };
  if (!gst.autoConfigured()) { gstAuto.error = 'BlueDart or Supabase not configured in .env'; return later(); }
  if (tallyBusy()) return;   // another job holds Tally: try again next minute
  gstAutoBusy = true;
  try {
    if (!(await ping()) || !(await activeCompany())) throw new Error('Tally is not running or no company is open');
    const to = gst.istToday();
    await periodGuard(to);
    const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (AUTO_DAYS - 1));
    const from = d.toISOString().slice(0, 10);
    const vouchers = await gst.readTally(gst.isoDays(from, to));
    gstAutoBusy = false;   // the rest is Supabase + BigQuery only
    const r = await gst.autoCloseDispatched(vouchers);
    gstAuto.result = { ...r, from, to };
    gstAuto.error = null;
    if (r.closed) console.log(`BlueDart check: closed ${r.closed} — ${r.closedList.join(', ')}`);
    for (const rep of Object.values(gstReport)) if (rep) await gst.enrich(rep);   // show it on the lists
  } catch (err) {
    gstAuto.error = err.message;
    console.log(`BlueDart check failed: ${err.message}`);
  } finally {
    gstAutoBusy = false;
    later();
  }
}
setInterval(() => { gstAutoTick().catch(() => {}); }, 60e3);

async function handleGst(url, req, res) {
  const p = url.pathname.slice('/api/gst'.length);
  const q = (k) => url.searchParams.get(k) || '';
  const kindOf = (k) => (gst.KINDS[k] ? k : null);

  if (p === '/build' && req.method === 'POST') {
    const { kind, from, to } = await readBody(req);
    if (!kindOf(kind)) return json(res, 400, { error: 'unknown tab' });
    if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) return json(res, 400, { error: 'pick an invoice-date range (from ≤ to)' });
    if (gst.isoDays(from, to).length > gst.MAX_DAYS) return json(res, 400, { error: `at most ${gst.MAX_DAYS} days per Fetch` });
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    try { await periodGuard(to < gst.istToday() ? to : gst.istToday()); } catch (err) { return json(res, err.status || 502, { error: err.message }); }
    gstBuild(kind, from, to);
    return json(res, 202, { started: true });
  }
  if (p === '/rows') {
    const kind = kindOf(q('kind'));
    if (!kind) return json(res, 400, { error: 'unknown tab' });
    return json(res, 200, gstReport[kind] || { docs: [], missing: [] });
  }
  if (p === '/excel') {
    const kind = kindOf(q('kind')), r = kind && gstReport[kind];
    if (!r) return json(res, 409, { error: 'press Fetch first' });
    const buffer = await gstReportToXlsx(r);
    const range = r.from === r.to ? r.from : `${r.from}-to-${r.to}`;
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${kind === 'ewb' ? 'eway-bills' : 'e-invoices'}-${range}.xlsx"`,
    });
    return res.end(Buffer.from(buffer));
  }
  // Close — Supabase only, safe while Tally is busy. Name and reason are both required.
  if (p === '/close' && req.method === 'POST') {
    const { kind, list, id, who, reason } = await readBody(req);
    const r = kindOf(kind) && gstReport[kind];
    if (!r) return json(res, 409, { error: 'press Fetch first' });
    const name = String(who || '').trim().slice(0, 80), why = String(reason || '').trim().slice(0, 500);
    if (!name) return json(res, 400, { error: 'a name is needed to record who closed it' });
    if (!why) return json(res, 400, { error: 'a reason is needed to close it' });
    try {
      const out = await gst.close(r, list === 'missing' ? 'missing' : 'docs', String(id), name, why);
      return json(res, 200, { ...out, counts: r.counts, missingCounts: r.missingCounts });
    } catch (err) { return json(res, err.status || 502, { error: err.message }); }
  }
  // What a portal check for this range would pull (and cost) — Supabase only.
  if (p === '/portal-plan') {
    const from = q('from'), to = q('to');
    if (!ISO.test(from) || !ISO.test(to) || from > to) return json(res, 400, { error: 'pick a date range (from ≤ to)' });
    try { return json(res, 200, await gst.portalPlan(from, to)); }
    catch (err) {
      return json(res, 502, { error: /ewb_portal_check/.test(err.message)
        ? 'Saved portal checks are not set up — run update_ewb_portal_check.sql in the Supabase SQL editor. No GSP call was made.'
        : err.message });
    }
  }
  if (p === '/portal' && req.method === 'POST') {
    const { from, to } = await readBody(req);
    if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) return json(res, 400, { error: 'pick a date range (from ≤ to)' });
    if (gst.isoDays(from, to).length > gst.PORTAL_MAX_DAYS) return json(res, 400, { error: `at most ${gst.PORTAL_MAX_DAYS} days per portal check` });
    if (to > gst.istToday()) return json(res, 400, { error: 'the range runs into the future' });
    if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    gstPortal(from, to);
    return json(res, 202, { started: true });
  }
  return json(res, 404, { error: 'not found' });
}

// --- Missing Invoice (Gap Ledger) -----------------------------------------------------------------
// Fetch reads the range's Sales-class voucher numbers from Tally one month at a time, then finds the
// gaps and checks them in Unicommerce (lib/missing.mjs). Changing the type or series re-analyses the
// vouchers already read — Unicommerce only, no Tally.
async function miRun(fn) {
  try { await fn(); } catch (err) { miBusy = false; miJob = { ...miJob, running: false, message: '', error: err.message }; }
}

async function miBuild(from, to) {
  const t0 = Date.now();
  const chunks = mi.monthChunks(from, to);
  miJob = { type: 'build', running: true, done: 0, total: chunks.length, message: 'Reading sales voucher numbers from Tally…', error: '' };
  await miRun(async () => {
    miBusy = true;
    let company, vouchers = [];
    try {
      company = await activeCompany();
      if (!company) throw new Error('No company is open in Tally.');
      for (let i = 0; i < chunks.length; i++) {
        miJob.message = `Reading sales voucher numbers from Tally — month ${i + 1} of ${chunks.length}…`;
        vouchers = vouchers.concat(await salesNumbersInRange(chunks[i][0], chunks[i][1]));
        miJob.done = i + 1;
      }
    } finally { miBusy = false; }
    if (!vouchers.length) throw new Error('Tally returned no sales vouchers for these dates — check the company open in Tally covers them.');
    const base = { from, to, company, vouchers, builtAt: new Date().toISOString() };
    miJob.message = 'Finding gaps and checking them in Unicommerce…';
    const a = await mi.analyze(base, { onProgress: (m) => { miJob.message = m; } });
    miReport = { ...base, ...a };
    miJob = { type: 'build', running: false, error: '', message: miDoneText(Date.now() - t0) };
  });
}

async function miAnalyze(type, series) {
  const t0 = Date.now();
  miJob = { type: 'analyze', running: true, done: 0, total: 0, message: 'Finding gaps and checking them in Unicommerce…', error: '' };
  await miRun(async () => {
    const a = await mi.analyze(miReport, { type, series, onProgress: (m) => { miJob.message = m; } });
    miReport = { ...miReport, ...a };
    miJob = { type: 'analyze', running: false, error: '', message: miDoneText(Date.now() - t0) };
  });
}

function miDoneText(ms) {
  const r = miReport, c = r.counts;
  return (r.ucNote ? `${r.ucNote} ` : '')
    + `Done in ${Math.round(ms / 1000)} s — ${r.scanned.toLocaleString('en-IN')} ${r.type} vouchers in ${r.series === '*' ? 'all series' : r.series}: `
    + `${c.missing} truly missing, ${c.tally} cancelled in Tally, ${c.uc} cancelled in Unicommerce.`;
}

async function handleMissing(url, req, res) {
  const p = url.pathname.slice('/api/mi'.length);
  const running = () => Boolean(miJob?.running);
  if (p === '/build' && req.method === 'POST') {
    const { from, to } = await readBody(req);
    if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) return json(res, 400, { error: 'pick a date range (from ≤ to)' });
    if (gst.isoDays(from, to).length > mi.MAX_DAYS) return json(res, 400, { error: `at most ${mi.MAX_DAYS} days per Fetch` });
    if (running() || tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
    try { await periodGuard(to < gst.istToday() ? to : gst.istToday()); } catch (err) { return json(res, err.status || 502, { error: err.message }); }
    miBuild(from, to);
    return json(res, 202, { started: true });
  }
  if (p === '/analyze' && req.method === 'POST') {
    const { type, series } = await readBody(req);
    if (!miReport) return json(res, 409, { error: 'press Fetch first' });
    if (running()) return json(res, 409, { error: 'still working on the last request — try again in a moment' });
    miAnalyze(String(type || ''), String(series || ''));
    return json(res, 202, { started: true });
  }
  if (p === '/rows') {
    if (!miReport) return json(res, 200, { rows: [] });
    const { vouchers, ...rest } = miReport;   // the raw voucher list stays on the server
    return json(res, 200, rest);
  }
  if (p === '/excel') {
    if (!miReport) return json(res, 409, { error: 'press Fetch first' });
    const buffer = await missingInvoiceToXlsx(miReport);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="missing-invoices-${miReport.from}-to-${miReport.to}.xlsx"`,
    });
    return res.end(Buffer.from(buffer));
  }
  return json(res, 404, { error: 'not found' });
}

// --- Purchase Import (BOE Costing Portal -> import Purchase voucher) ---------------------------------
// Look up a BOE: read from the portal, matched to Tally items, checked against Tally (lib/purchase.mjs).
// Posting is OFF unless PURCHASE_POSTING=on in .env: the foreign-currency amount format sent to Tally is
// unproven until a test voucher has been posted, read back and compared with a hand-entered one.
const postingOn = () => String(process.env.PURCHASE_POSTING || '').toLowerCase() === 'on';
// Tally's import reply, in words: error_list items can be objects, which printed as "[object Object]".
const importErrors = (r) => {
  const list = [...(r?.error_list || []), ...(r?.data?.error_list || [])];
  const txt = list.map((e) => (typeof e === 'string' ? e : e?.error || e?.message || e?.line_error || JSON.stringify(e))).filter(Boolean);
  const res = r?.data?.import_result || r?.import_result;
  if (res && (Number(res.errors) || Number(res.exceptions))) txt.push(`import result ${JSON.stringify(res)}`);
  return txt.join('; ');
};
// Every Purchase Import reply from Tally is kept (data/purchase-import.log), so a refusal can be read later.
const logImport = (what, sent, reply) => {
  try { appendFileSync(join(HERE, 'data', 'purchase-import.log'), `${JSON.stringify({ at: new Date().toISOString(), what, sent, reply })}\n`); } catch { /* best effort */ }
};
let piMasters = null;   // { at, company, items, ledgers, godowns } shared by lookups a few minutes apart
const strip = (p) => { const { masters, ...rest } = p; return rest; };

// `want`: the company picked on the screen. Every read and write goes to the company OPEN in Tally (no
// SVCURRENTCOMPANY anywhere in this app), so a pick that is not the open one is refused, not redirected.
async function piPrepare(beNo, want = '', choices = {}) {
  const ctx = await ucTallyContext();   // ping + open company
  if (want && want !== ctx.company) {
    throw Object.assign(new Error(`Tally has "${ctx.company}" open, not "${want}". Switch to it in Tally (F3: Select Company), then Fetch again.`), { status: 409 });
  }
  if (!piMasters || piMasters.company !== ctx.company || Date.now() - piMasters.at > 5 * 60e3) piMasters = { company: ctx.company, at: Date.now() };
  // prepare() fills piMasters itself (stock items with group/brand, groups, categories); ledgers come back.
  const p = await pu.prepare(beNo, { company: ctx.company, masters: piMasters, choices: choices || {} });
  piMasters.ledgers = p.masters.ledgers;
  return p;
}

async function handlePurchase(url, req, res) {
  const p = url.pathname.slice('/api/pi'.length);
  const q = (k) => url.searchParams.get(k) || '';
  const busy = () => json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });

  if (p === '/config') return json(res, 200, { boeConfigured: pu.boeDb.configured(), postingOn: postingOn() });

  if (p === '/boe') {
    if (tallyBusy()) return busy();
    piBusy = true;
    try { return json(res, 200, strip(await piPrepare(q('no'), q('company')))); }
    catch (err) { return json(res, err.status || 502, { error: err.message }); }
    finally { piBusy = false; }
  }

  // Pickers: search the stock items / supplier ledgers already read for the last lookup.
  if (p === '/items' || p === '/parties') {
    const list = p === '/items' ? piMasters?.items : piMasters?.ledgers && [...piMasters.ledgers.values()];
    if (!list) return json(res, 409, { error: 'look up a BOE first' });
    const words = q('q').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [...list].filter((n) => words.every((w) => n.toLowerCase().includes(w))).slice(0, 40);
    return json(res, 200, { results: hits });
  }

  // Which of these names are already stock items (no Tally call: the list read for the last lookup).
  if (p === '/exists' && req.method === 'POST') {
    const b = await readBody(req);
    if (!piMasters?.items) return json(res, 409, { error: 'look up a BOE first' });
    const byKey = new Map([...piMasters.items].map((n) => [n.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase(), n]));
    const out = {};
    for (const n of (b.names || []).map(String)) out[n] = piMasters.items.has(n) ? n : byKey.get(n.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()) || null;
    return json(res, 200, { names: out });
  }

  // Check the BOE again with the screen's choices (ticks, names, group / brand of new items).
  if (p === '/review' && req.method === 'POST') {
    const b = await readBody(req);
    if (tallyBusy()) return busy();
    piBusy = true;
    try { return json(res, 200, strip(await piPrepare(b.be_no, b.company || '', b.choices))); }
    catch (err) { return json(res, err.status || 502, { error: err.message }); }
    finally { piBusy = false; }
  }

  // Remember a pick (item for a supplier + description, or the supplier's ledger), then look up again.
  if (p === '/choose' && req.method === 'POST') {
    const b = await readBody(req);
    if (!piMasters) return json(res, 409, { error: 'look up a BOE first' });
    if (b.item) {
      if (!piMasters.items?.has(b.item)) return json(res, 400, { error: `"${b.item}" is not a stock item in Tally` });
      pu.saveItemChoice(piMasters.company, b.supplier, b.description, b.item, b.who);
    } else if (b.party) {
      if (!piMasters.ledgers?.has(String(b.party).toLowerCase())) return json(res, 400, { error: `"${b.party}" is not a supplier ledger in Tally` });
      pu.savePartyChoice(piMasters.company, b.supplier, b.party);
    } else return json(res, 400, { error: 'nothing to save' });
    if (tallyBusy()) return busy();
    piBusy = true;
    try { return json(res, 200, strip(await piPrepare(b.be_no, b.company || ''))); }
    catch (err) { return json(res, err.status || 502, { error: err.message }); }
    finally { piBusy = false; }
  }

  // Post one BOE. Re-checked fresh first; the read-back, not the import response, is the proof.
  if (p === '/post' && req.method === 'POST') {
    const b = await readBody(req);
    if (!postingOn()) return json(res, 409, { error: 'Posting is switched off until a test voucher has been checked (PURCHASE_POSTING=on in .env).' });
    if (tallyBusy()) return busy();
    piBusy = true;
    try {
      piMasters = null;   // fresh masters for a write
      let pr = await piPrepare(b.be_no, b.expectedCompany || '', b.choices);   // refused if Tally's open company is not the one picked
      if (!pr.ready) return json(res, 409, { error: `Not ready: ${pr.problems.join('; ')}` });

      // 1) New stock items first, then confirmed by reading the item list again.
      const created = [];
      if (pr.newItems.length) {
        const toCreate = pr.newItems.map((n) => n.name);
        let mresp;
        try { mresp = await importMasters(pr.newItems.map(pu.buildStockItem)); logImport('stock items', pr.newItems, mresp); }
        catch (err) { return json(res, 502, { error: `Creating stock items failed: ${err.message}` }); }
        piMasters = null;
        pr = await piPrepare(b.be_no, b.expectedCompany || '', b.choices);   // fresh item list: the new ones must now exist
        const stillNew = pr.newItems.map((n) => n.name);
        if (stillNew.length) {
          const errs = importErrors(mresp);
          return json(res, 502, { error: `stock item(s) not created in Tally: ${stillNew.join(', ')}${errs ? ` — Tally said: ${errs}` : ''}. No voucher was posted.` });
        }
        created.push(...toCreate);
        if (!pr.ready) return json(res, 409, { error: `Items created (${created.join(', ')}), but the BOE is not ready: ${pr.problems.join('; ')}. No voucher was posted.` });
      }

      // 2) The voucher — Optional (provisional) unless the screen says otherwise: it then affects neither the
      // books nor stock until someone makes it regular in Tally (Ctrl+L).
      const optional = b.optional !== false;
      const voucher = pu.buildPurchaseVoucher(pr, { optional });
      pr._optional = optional;
      let response;
      try { response = await importVouchers([voucher]); logImport(`voucher BOE ${pr.boe.be_no}`, voucher, response); }
      catch (err) { return json(res, 502, { error: `Tally import failed: ${err.message}` }); }
      const { voucher: back, checks } = await pu.readBack(pr);
      if (!back) {
        const errs = importErrors(response);
        const hint = optional && !errs ? ' It was sent as an Optional voucher — check the Day Book in Tally with optional vouchers shown before posting again.' : '';
        return json(res, 502, { error: `${checks.join('; ')}${errs ? ` — Tally said: ${errs}` : ''}${hint}`, response });
      }
      pu.recordPosted({ company: pr.code, be_no: pr.boe.be_no, voucher_number: back.number, voucher_date: back.date, master_id: back.masterId,
        party: pr.party, amount_fx: pr.totals.invoiceUsd, rate: pr.totals.rate, payload: voucher, checks, test_mode: Boolean(b.testMode), optional });
      // Remember every line's item for this supplier + description, so the next BOE fills itself in.
      for (const l of pr.lines) if (l.tally.length === 1) pu.saveItemChoice(pr.company, pr.boe.supplier_name, l.description, l.tally[0].item, 'posted');
      return json(res, 200, { created: true, voucherNumber: back.number, date: back.date, company: pr.company, checks, itemsCreated: created, optional: back.optional });
    } catch (err) { return json(res, err.status || 502, { error: err.message }); }
    finally { piBusy = false; }
  }

  if (p === '/history') return json(res, 200, { rows: pu.listPosted(q('limit')) });
  return json(res, 404, { error: 'not found' });
}

// --- COD Import (courier COD remittance file -> one Journal per AWB) --------------------------------
// Upload = parse the file, then one job checks every AWB against Tally (journals naming it, the sales
// invoice carrying it). Post = another job: fresh duplicate check, numbered journals, read back in
// batches (lib/cod.mjs). Every Tally reply is kept in data/cod-import.log.
const codSalesCache = new Map();   // yyyymmdd -> { at, vouchers }: days read for the current upload
const codLog = (what, sent, reply) => {
  try { appendFileSync(join(HERE, 'data', 'cod-import.log'), `${JSON.stringify({ at: new Date().toISOString(), what, sent, reply })}\n`); } catch { /* best effort */ }
};

// The checked file is kept on disk, so an app restart (a deploy, or pm2's memory limit) does not lose it: the
// screen keeps showing the list, and posting then says "upload a COD file first" (2026-10-24). Restored only
// if it is under 4 hours old; posting re-checks Tally for journals anyway, and refuses another company.
const COD_REPORT_FILE = join(HERE, 'data', 'cod-report.json');
const COD_REPORT_MAX_AGE = 4 * 3600e3;
function codSave() {
  if (!codReport) return;
  try { writeFileSync(`${COD_REPORT_FILE}.tmp`, JSON.stringify(codReport)); renameSync(`${COD_REPORT_FILE}.tmp`, COD_REPORT_FILE); } catch { /* best effort */ }
}
try {
  const r = JSON.parse(readFileSync(COD_REPORT_FILE, 'utf8'));
  if (r?.rows && Date.now() - Date.parse(r.builtAt) < COD_REPORT_MAX_AGE) codReport = r;
} catch { /* none saved */ }

async function codCheck(parsed, fileName) {
  const t0 = Date.now();
  codJob = { type: 'check', running: true, message: `Checking ${parsed.rows.length} AWBs from ${fileName} against Tally…`, error: '' };
  try {
    const { company } = await ucTallyContext();
    codReport = await cod.check(parsed, { company, fileName, cache: codSalesCache, onProgress: (m) => { codJob.message = m; } });
    codSave();
    const c = codReport.counts;
    codJob = { type: 'check', running: false, error: '', message: `Checked ${c.all} AWBs in ${Math.round((Date.now() - t0) / 1000)} s — ${c.ready} ready to post, ${c.intally} already in Tally, ${c.blocked} blocked.` };
  } catch (err) {
    codJob = { type: 'check', running: false, message: '', error: err.message };
  }
}

async function codPost(awbs, optional) {
  codJob = { type: 'post', running: true, done: 0, total: awbs.length, message: 'Starting…', error: '' };
  try {
    const { company } = await ucTallyContext();
    if (company !== codReport.company) throw new Error(`Tally now has "${company}" open, but this file was checked against "${codReport.company}". Upload it again.`);
    let r;
    try { r = await cod.post(codReport, awbs, { optional, log: codLog, onProgress: (p) => Object.assign(codJob, p) }); }
    finally { codSave(); }   // rows posted so far are marked done, even if a later batch stopped
    const dated = Object.entries(r.dates).sort().map(([d, n]) => `${n} dated ${d.split('-').reverse().join('-')}`).join(', ');
    const range = r.firstNo ? ` (journals ${r.firstNo}${r.lastNo !== r.firstNo ? `–${r.lastNo}` : ''})` : '';
    codJob = { type: 'post', running: false, result: r,
      message: `Posted ${r.posted} journal(s)${range}${dated ? ` — ${dated}` : ''}${optional ? ', as Optional' : ''}.`
        + (r.skipped.length ? ` ${r.skipped.length} skipped (already in Tally or not ready).` : ''),
      error: r.errors.join(' | ') };
  } catch (err) {
    codJob = { type: 'post', running: false, message: '', error: err.message };
  }
}

async function handleCod(url, req, res) {
  const p = url.pathname.slice('/api/cod'.length);
  const busy = () => json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });

  if (p === '/upload' && req.method === 'POST') {
    const b = await readBody(req);
    if (tallyBusy()) return busy();
    let parsed;
    try { parsed = await cod.parseFile(Buffer.from(String(b.data || ''), 'base64'), String(b.name || '')); }
    catch (err) { return json(res, err.status || 400, { error: err.message }); }
    // Every upload reads Tally fresh: an invoice corrected in Tally a minute ago (e.g. a COD charge
    // added so the amount matches the file) must not be checked against the copy read before.
    codSalesCache.clear();
    codCheck(parsed, String(b.name || 'file'));
    return json(res, 202, { started: true, courier: parsed.label, rows: parsed.rows.length });
  }
  if (p === '/rows') return json(res, 200, codReport || { rows: [] });
  if (p === '/post' && req.method === 'POST') {
    const b = await readBody(req);
    if (!codReport) return json(res, 409, { error: 'upload a COD file first' });
    if (tallyBusy()) return busy();
    const awbs = (Array.isArray(b.awbs) ? b.awbs : []).map(String);
    if (!awbs.length) return json(res, 400, { error: 'nothing selected' });
    codPost(awbs, Boolean(b.optional));
    return json(res, 202, { started: true, count: awbs.length });
  }
  if (p === '/history') return json(res, 200, { rows: cod.listPosted(url.searchParams.get('limit')) });
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/api/state') {
      // The open company is re-read on every poll, never taken from the cached
      // report: closing a company in Tally must not leave a stale name on screen
      // next to a Create button.
      // While a job runs, this endpoint touches Tally not at all and answers
      // from the last known values. Polling the gateway during a build is
      // exactly the overlap that wedges it.
      let tallyUp = lastSeen.tallyUp, openCompany = lastSeen.openCompany, companies = lastSeen.companies, period = lastSeen.period;
      if (!tallyBusy()) {
        tallyUp = await ping();
        openCompany = null; companies = []; period = null;
        if (tallyUp) {
          try {
            openCompany = await activeCompany();
            companies = await loadedCompanies();
            if (openCompany) period = await companyPeriod();
          } catch { /* report it as unknown rather than failing the poll */ }
        }
        lastSeen = { tallyUp, openCompany, companies, period };
      }
      return json(res, 200, {
        tallyUp,
        openCompany,
        companies,
        period,   // the open company's current period (Alt+F2), { from, to } as yyyymmdd
        today: gst.istToday(),
        job,
        sjBusy,
        cnJob,
        cnReport: cnReport && { builtAt: cnReport.builtAt, from: cnReport.from, to: cnReport.to, company: cnReport.company, counts: cnReport.counts, totals: cnReport.totals, truncated: cnReport.truncated },
        ucJob,
        ucReport: ucReport && { builtAt: ucReport.builtAt, from: ucReport.from, to: ucReport.to, company: ucReport.company, rowCount: ucReport.rowCount, counts: ucReport.counts, totals: ucReport.totals },
        gstJob,
        gstReport: { ewb: gstSummary(gstReport.ewb), einv: gstSummary(gstReport.einv) },
        gstUsage: gst.gspUsage(),
        gstAuto,
        miJob,
        miReport: miReport && { builtAt: miReport.builtAt, from: miReport.from, to: miReport.to, company: miReport.company,
          type: miReport.type, series: miReport.series, counts: miReport.counts },
        codJob,
        codReport: codReport && { builtAt: codReport.builtAt, company: codReport.company, fileName: codReport.fileName, counts: codReport.counts },
        report: report && {
          builtAt: report.builtAt, company: report.company, book: report.book, range: report.range,
          counts: report.counts, totals: report.totals,
        },
      });
    }

    if (url.pathname === '/api/build' && req.method === 'POST') {
      if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
      const { book = 'live', from, to } = await readBody(req);
      if (!from || !to) return json(res, 400, { error: 'pick a from and to date' });
      startBuild(book, from, to);
      return json(res, 202, { started: true });
    }

    if (url.pathname === '/api/rows') {
      if (!report) return json(res, 200, { rows: [], total: 0 });
      const status = url.searchParams.get('status') || '';
      const q = (url.searchParams.get('q') || '').toLowerCase();
      // Cap raised from 2000: this slices an array already built in memory (no Tally round-trip), and
      // the old cap silently broke "select all" on a report with more than 1000-2000 ready rows — the
      // header checkbox only ever saw whatever page the browser had loaded (bug, 2026-10-16).
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 100000);
      const offset = Number(url.searchParams.get('offset') || 0);
      let rows = report.rows;
      if (status) rows = rows.filter((r) => r.status === status);
      if (q) {
        rows = rows.filter((r) => [r.wcid, r.customer, r.sheetEmail, r.mi?.stockItem, r.mi?.party]
          .some((v) => v && String(v).toLowerCase().includes(q)));
      }
      return json(res, 200, { total: rows.length, rows: rows.slice(offset, offset + limit) });
    }

    if (url.pathname === '/api/create' && req.method === 'POST') {
      if (tallyBusy()) return json(res, 409, { error: 'Tally is busy with another job — try again in a moment' });
      const { wcids } = await readBody(req);
      if (!Array.isArray(wcids) || !wcids.length) return json(res, 400, { error: 'no rows selected' });
      startCreate(wcids);
      return json(res, 202, { started: true, count: wcids.length });
    }

    if (url.pathname === '/api/excel') {
      if (!report) return json(res, 409, { error: 'build the report first' });
      const buffer = await reportToXlsx(report);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="material-out-${report.book}-${stamp}.xlsx"`,
      });
      return res.end(Buffer.from(buffer));
    }

    if (url.pathname.startsWith('/api/sj/')) return await handleStockJournal(url, req, res);
    if (url.pathname.startsWith('/api/cn/')) return await handleCreditNote(url, req, res);
    if (url.pathname.startsWith('/api/uc/')) return await handleUcSales(url, req, res);
    if (url.pathname.startsWith('/api/gst/')) return await handleGst(url, req, res);
    if (url.pathname.startsWith('/api/mi/')) return await handleMissing(url, req, res);
    if (url.pathname.startsWith('/api/pi/')) return await handlePurchase(url, req, res);
    if (url.pathname.startsWith('/api/cod/')) return await handleCod(url, req, res);

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HPZ Tally app (Material Out + Stock Journal + Credit Note)  ->  http://localhost:${PORT}`);
  console.log(rms.configured() ? 'RMS link configured.' : 'RMS link NOT configured — set RMS_API_URL and RMS_AGENT_SECRET in .env.');
  console.log('Reads and writes whichever company is open in Tally.');
});
