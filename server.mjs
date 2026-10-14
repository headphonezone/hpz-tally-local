// Must stay the first import: it loads .env before lib/tally.mjs reads its URL at load time.
import './lib/env.mjs';

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ping, activeCompany, loadedCompanies, listGodowns, listStockItemNames, voucherNumbersOfType, importVouchers, existingLedgers, creditNoteItems, readCreditNote } from './lib/tally.mjs';
import * as cn from './lib/creditnote.mjs';
import * as cnStore from './lib/cnstore.mjs';
import { buildReport } from './lib/report.mjs';
import { createMaterialOut } from './lib/create.mjs';
import { reportToXlsx } from './lib/excel.mjs';
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
let lastSeen = { tallyUp: false, openCompany: null, companies: [] };

// A Stock Journal posting holds Tally for several requests in a row. Material Out and Stock
// Journal share this one busy check, so neither side — nor the status poll — can overlap the
// other on the gateway. Overlapping requests wedge Tally.
let sjBusy = false;
let cnBusy = false;   // the same rule for Credit Notes: a preview or a posting holds the gateway
// cnJob is declared further down with the Credit Note code; a whole build or create job counts as busy.
const tallyBusy = () => Boolean(job?.running || sjBusy || cnBusy || cnJob?.running);

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

async function sjCreate(body) {
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

    const lines = sj.aggregate(entries);
    const validation = await sj.validateNames(lines, Boolean(unboxed));
    if (!validation.ok) return [422, { error: 'name not matched', unmatched: validation.unmatched }];

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
      narration: narrationText, refs, lines, total_qty: totalQty, test_mode: testMode,
    }, entries);

    sjBusy = false; // Tally work is done; the RMS call below does not touch the gateway.
    if (testMode) {
      store.markSynced(id, false, 'test posting — RMS not updated');
      return [200, { created: true, id, voucherNumber, totalQty, company, skipped, rms: { synced: false, test: true } }];
    }
    const sync = await syncToRms(id, voucherNumber, toGodown, entries);
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
    return json(res, 200, await syncToRms(j.id, j.voucher_number, j.to_godown, j.entries));
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
  const creditedUnits = cn.creditedUnitsBySku(existing, d.rows);

  let note = null;
  if (!problems.length) {
    const res = cn.computeCreditNote({ rows: selected, uc: d.unicommerce, creditedUnits });
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
        const r = cn.computeCreditNote({ rows: d.rows.filter((x) => !x.credit_note_no), uc: d.unicommerce, creditedUnits: cn.creditedUnitsBySku(existing.get(d.order_no) || [], d.rows) });
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
      let tallyUp = lastSeen.tallyUp, openCompany = lastSeen.openCompany, companies = lastSeen.companies;
      if (!tallyBusy()) {
        tallyUp = await ping();
        openCompany = null; companies = [];
        if (tallyUp) {
          try {
            openCompany = await activeCompany();
            companies = await loadedCompanies();
          } catch { /* report it as unknown rather than failing the poll */ }
        }
        lastSeen = { tallyUp, openCompany, companies };
      }
      return json(res, 200, {
        tallyUp,
        openCompany,
        companies,
        job,
        sjBusy,
        cnJob,
        cnReport: cnReport && { builtAt: cnReport.builtAt, from: cnReport.from, to: cnReport.to, company: cnReport.company, counts: cnReport.counts, totals: cnReport.totals, truncated: cnReport.truncated },
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
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 2000);
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
