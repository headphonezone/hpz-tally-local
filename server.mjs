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
const tallyBusy = () => Boolean(job?.running || sjBusy || cnBusy);

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
async function cnPrepare(orderNo, rmaNumbers) {
  const d = await rms.cnOrder(orderNo);                       // RMS + Unicommerce (not Tally)
  const problems = [], warnings = [];
  const wanted = rmaNumbers?.length ? new Set(rmaNumbers) : null;
  const selected = d.rows.filter((r) => (wanted ? wanted.has(r.rma_number) : !r.credit_note_no));
  for (const r of selected) if (r.credit_note_no) problems.push(`${r.item} (${r.rma_number}) is already on credit note ${r.credit_note_no} in RMS`);
  if (!selected.length) problems.push('nothing to credit — every item of this order already has a credit note in RMS');
  if (d.unicommerce_error) problems.push(`Unicommerce: ${d.unicommerce_error}`);

  if (!(await ping())) throw Object.assign(new Error('Tally is not running'), { status: 503 });
  const company = await activeCompany();
  if (!company) throw Object.assign(new Error('Tally is running but no company is open'), { status: 503 });

  const grNos = new Set(await voucherNumbersOfType(cn.VOUCHER_TYPE));
  const retNos = new Set(await voucherNumbersOfType(RET_TYPE));
  const taken = new Set([...grNos, ...retNos, ...cnStore.issuedNumbers(company)]);
  const mine = cn.numbersOfOrder(d.order_no, new Set([...grNos, ...retNos]));
  const existing = [
    ...(await creditNoteItems(cn.VOUCHER_TYPE, mine.filter((n) => grNos.has(n)))).map((x) => ({ ...x, type: cn.VOUCHER_TYPE })),
    ...(await creditNoteItems(RET_TYPE, mine.filter((n) => retNos.has(n)))).map((x) => ({ ...x, type: RET_TYPE })),
  ];
  const creditedUnits = cn.creditedUnitsBySku(existing, d.rows);

  let note = null;
  if (!problems.length) {
    const res = cn.computeCreditNote({ rows: selected, uc: d.unicommerce, creditedUnits });
    problems.push(...res.problems); warnings.push(...res.warnings);
    note = res.note || null;
  }
  if (note) {
    // Masters must exist exactly; Tally would otherwise reject the voucher or create something new.
    const needLedgers = [note.party_ledger, ...note.lines.map((l) => l.ledger), ...note.tax.map((t) => t.ledger), ...(note.cod > 0 ? [cn.COD_LEDGER] : [])];
    const have = await existingLedgers(needLedgers);
    for (const l of [...new Set(needLedgers)]) if (!have.has(l)) problems.push(l === note.party_ledger ? `customer ledger "${l}" not found in Tally` : `ledger "${l}" not found in Tally`);
    const items = await stockItemNames();
    for (const l of note.lines) if (!items.has(l.item)) problems.push(`stock item "${l.item}" not found in Tally (name not matched)`);
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

async function cnCreate(body) {
  const { order_no, rma_numbers, expectedCompany } = body;
  const testMode = body.testMode === true;
  if (!order_no) return [400, { error: 'order_no is required' }];
  if (tallyBusy()) return [409, { error: 'Tally is busy with another job — try again in a moment' }];
  cnBusy = true;
  try {
    const p = await cnPrepare(String(order_no), Array.isArray(rma_numbers) ? rma_numbers.map(String) : null);
    if (expectedCompany && p.company !== expectedCompany) return [409, { error: `Tally's open company changed to "${p.company}". Check it is the right one, then try again.` }];
    if (p.problems.length || !p.note) return [422, { error: 'cannot post', problems: p.problems, warnings: p.warnings }];
    if (!p.voucher_date) return [422, { error: 'no received date in RMS for these items' }];

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

async function handleCreditNote(url, req, res) {
  const p = url.pathname.slice('/api/cn'.length);
  const q = (k) => url.searchParams.get(k) || '';

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
