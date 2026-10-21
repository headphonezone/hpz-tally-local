// Purchase Import tab: a Bill of Entry from the BOE Costing Portal -> an import Purchase voucher in Tally.
//
// Enter a BOE number. The BOE (supplier, invoice, USD value, exchange rate) and its lines (description,
// qty, USD unit price) are read from the portal's own Supabase project (BOE_SUPABASE_URL / _KEY). Each
// line is matched to a Tally stock item, in this order of trust:
//   1. link   — the portal's boe_item_tally_link for this very BOE line (status auto / confirmed),
//               filtered to the open company (HZ / FV). A line booked as several items keeps the split.
//   2. alias  — the portal's tally_item_map: supplier + description -> item, used only when it names
//               exactly one item that exists in the open company.
//   3. saved  — an item picked in this app before for the same supplier + description.
//   4. none   — blocked until someone picks the item (the pick is saved for next time).
//
// THE VOUCHER is a copy of how the company already books an import, read off its latest import
// purchase (narration naming a BOE) — voucher type, class, purchase ledger, freight ledger, godown,
// batch. On Headphone Zone, 2026-10-21, that was voucher #298 (BOE 4423722) / #276 (BOE 4058321):
//   Purchase, class Import, Item Invoice;  date = reference date = BE date;  reference = invoice no.
//   Cr supplier (USD @ BOE rate), bill New Ref = invoice no.
//   Dr each item, USD rate, godown "Chennai Wh -Good", batch "Primary Batch", allocated to "Import of Goods".
//   Dr "Shipping Charges (Imports)" for the supplier's freight: invoice value - sum(qty x price), in USD.
//   Narration "BOE no: 4423722  BE dt: 14/10/2026  USD $5525.29  ₹96.2159". No duty / IGST here —
//   customs is booked separately.
// Exchange rate: always the BOE's own (decided 2026-10-21).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { client } from './supabase.mjs';
import { purchaseVouchersInRange, readPurchaseVoucher, existingLedgers, supplierLedgerNames, listGodowns, listStockItemNames } from './tally.mjs';

export const boeDb = client({
  url: () => process.env.BOE_SUPABASE_URL, key: () => process.env.BOE_SUPABASE_KEY, label: 'BOE Costing Portal',
  missing: 'The BOE Costing Portal is not configured — set BOE_SUPABASE_URL and BOE_SUPABASE_KEY in .env (the BOE-Costing Supabase project\'s service key).',
});

// --- local store: picks remembered, BOEs posted --------------------------------------------------
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'purchase.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS item_choice (
    company TEXT NOT NULL, supplier_key TEXT NOT NULL, desc_key TEXT NOT NULL,
    tally_item TEXT NOT NULL, chosen_by TEXT, chosen_at TEXT NOT NULL,
    PRIMARY KEY (company, supplier_key, desc_key));
  CREATE TABLE IF NOT EXISTS party_choice (
    company TEXT NOT NULL, supplier_key TEXT NOT NULL, ledger TEXT NOT NULL, chosen_at TEXT NOT NULL,
    PRIMARY KEY (company, supplier_key));
  -- One row per BOE posted from this app, confirmed by read-back.
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, be_no TEXT NOT NULL,
    voucher_number TEXT, voucher_date TEXT, master_id TEXT, party TEXT, amount_fx REAL, rate REAL,
    payload TEXT NOT NULL, checks TEXT, test_mode INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE (company, be_no));
`);

// Same keys as the portal's tally_map_key / tally_supplier_key, so a lookup agrees by construction.
export const mapKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const supplierKey = (s) => mapKey(String(s || '').replace(/[.,]/g, ' '));
// Looser key for matching a supplier to a Tally ledger: "CO.,LIMITED" / "CO LTD" / "LLC" all drop out.
const partyKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .split(' ').filter((w) => w && !['co', 'ltd', 'limited', 'company', 'inc', 'llc', 'corp', 'corporation', 'pvt', 'private', 'the', 'technology', 'technologies'].includes(w)).join(' ');
const itemKey = (name) => String(name || '').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

export const companyCode = (name) => (/ferrari/i.test(name || '') ? 'FV' : /headphone/i.test(name || '') ? 'HZ' : null);
const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const ymd = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');
const isoOf = (y) => `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
const shiftDays = (y, n) => { const d = new Date(`${isoOf(y)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).replace(/-/g, ''); };
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '');
const dmy = (y) => `${y.slice(6, 8)}/${y.slice(4, 6)}/${y.slice(0, 4)}`;

export function saveItemChoice(company, supplier, description, item, by) {
  db.prepare(`INSERT INTO item_choice (company, supplier_key, desc_key, tally_item, chosen_by, chosen_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (company, supplier_key, desc_key) DO UPDATE SET tally_item = excluded.tally_item, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at`)
    .run(companyCode(company), supplierKey(supplier), mapKey(description), item, by || null, new Date().toISOString());
}
export function savePartyChoice(company, supplier, ledger) {
  db.prepare(`INSERT INTO party_choice (company, supplier_key, ledger, chosen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (company, supplier_key) DO UPDATE SET ledger = excluded.ledger, chosen_at = excluded.chosen_at`)
    .run(companyCode(company), supplierKey(supplier), ledger, new Date().toISOString());
}
const savedItem = (code, supplier, description) => db.prepare('SELECT tally_item FROM item_choice WHERE company = ? AND supplier_key = ? AND desc_key = ?')
  .get(code, supplierKey(supplier), mapKey(description))?.tally_item || null;
const savedParty = (code, supplier) => db.prepare('SELECT ledger FROM party_choice WHERE company = ? AND supplier_key = ?')
  .get(code, supplierKey(supplier))?.ledger || null;
export const postedBoe = (company, beNo) => db.prepare('SELECT * FROM posted WHERE company = ? AND be_no = ?').get(company, String(beNo));
export function recordPosted(row) {
  db.prepare(`INSERT INTO posted (company, be_no, voucher_number, voucher_date, master_id, party, amount_fx, rate, payload, checks, test_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.company, row.be_no, row.voucher_number, row.voucher_date, row.master_id, row.party,
    row.amount_fx, row.rate, JSON.stringify(row.payload), JSON.stringify(row.checks || []), row.test_mode ? 1 : 0, new Date().toISOString());
}
export const listPosted = (limit = 200) => db.prepare('SELECT id, company, be_no, voucher_number, voucher_date, party, amount_fx, rate, checks, test_mode, created_at FROM posted ORDER BY id DESC LIMIT ?')
  .all(Math.min(Number(limit) || 200, 1000)).map((r) => ({ ...r, checks: JSON.parse(r.checks || '[]'), test_mode: Boolean(r.test_mode) }));

// --- BOE from the portal --------------------------------------------------------------------------
export async function fetchBoe(beNo) {
  const be = String(beNo || '').trim();
  if (!/^\d{5,9}$/.test(be)) throw Object.assign(new Error('a BOE number is 5-9 digits'), { status: 400 });
  const e = encodeURIComponent(be);
  const [boe] = await boeDb.sb(`boes?select=be_no,be_date,port_code,importer_name,supplier_name,inv_no,inv_date,inv_value_usd,exchange_rate,hawb_no&be_no=eq.${e}`);
  if (!boe) throw Object.assign(new Error(`BOE ${be} is not in the BOE Costing Portal`), { status: 404 });
  const items = await boeDb.sb(`boe_items?select=global_sno,invsno,itemsn,cth,description,unit_price_usd,qty,uqc&be_no=eq.${e}&order=invsno.asc,itemsn.asc`);
  let links = [], aliases = [];
  try {
    links = await boeDb.sb(`boe_item_tally_link?select=invsno,itemsn,company,voucher_line,tally_item,tally_qty,tally_rate,link_kind,status&be_no=eq.${e}&status=in.(auto,confirmed)&order=voucher_line.asc`);
    const keys = [...new Set(items.map((i) => mapKey(i.description)))];
    if (keys.length) {
      aliases = await boeDb.selectIn('tally_item_map', 'desc_key,tally_item,status,evidence_lines,in_hz_master,in_fv_master', 'desc_key', keys,
        `&supplier_key=eq.${encodeURIComponent(supplierKey(boe.supplier_name))}&status=in.(auto,confirmed)`);
    }
  } catch { /* migration 015 not applied: no portal links, only saved picks */ }
  return { boe, items, links, aliases };
}

// --- what the company already does: its latest import purchase --------------------------------------
const templateCache = new Map();   // company -> { at, t }
export async function importTemplate(company) {
  const hit = templateCache.get(company);
  if (hit && Date.now() - hit.at < 3600e3) return hit.t;
  const to = todayYmd();
  const list = (await purchaseVouchersInRange(shiftDays(to, -180), to))
    .filter((v) => !v.cancelled && /\b(?:B\.?\s*E|BOE)\b/i.test(v.narration))
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.masterId) - Number(b.masterId));
  const last = list.at(-1);
  if (!last) return null;
  const v = await readPurchaseVoucher(last.masterId, last.date);
  if (!v || !v.items.length) return null;
  const purchaseLedger = v.items[0].ledger;
  // The freight ledger: the latest import voucher that HAS a non-party ledger besides the purchase one.
  let freightLedger = v.ledgers.find((l) => !l.isParty && l.ledger !== v.party && l.ledger !== purchaseLedger)?.ledger || null;
  for (const o of list.slice(0, -1).reverse()) {
    if (freightLedger) break;
    const w = await readPurchaseVoucher(o.masterId, o.date);
    freightLedger = w?.ledgers.find((l) => !l.isParty && l.ledger !== w.party && l.ledger !== w.items[0]?.ledger)?.ledger || null;
  }
  const t = {
    from: `voucher ${v.number} of ${dmy(v.date)} (${v.party})`,
    voucherType: v.type, className: v.className, purchaseLedger, freightLedger,
    godown: v.items[0].godown, batch: v.items[0].batch || 'Primary Batch',
    placeOfSupply: v.placeOfSupply, consigneeCountry: v.consigneeCountry || 'India', consigneeState: v.consigneeState,
    consigneeName: v.consigneeName, consigneeGstin: v.consigneeGstin,
  };
  templateCache.set(company, { at: Date.now(), t });
  return t;
}

// Purchase vouchers that already book this BOE: the narration names its number, or the same supplier
// invoice is on a purchase from the same party. Window: 30 days before the BE date to 120 after.
async function existingFor(boe, partyLedger) {
  const from = shiftDays(ymd(boe.be_date), -30);
  const to = [shiftDays(ymd(boe.be_date), 120), todayYmd()].sort()[0];
  if (to < from) return [];
  const re = new RegExp(`(^|\\D)${boe.be_no}(\\D|$)`);
  return (await purchaseVouchersInRange(from, to)).filter((v) => !v.cancelled && (re.test(v.narration)
    || (boe.inv_no && v.reference && v.reference.trim().toLowerCase() === String(boe.inv_no).trim().toLowerCase()
      && (!partyLedger || v.party === partyLedger))))
    .map((v) => ({ number: v.number, date: v.date, type: v.type, party: v.party, narration: v.narration, reference: v.reference }));
}

// --- prepare: everything the screen shows, and everything Post re-checks -------------------------------
// `masters` lets one request share the slow lookups (all ledgers, all stock items) with the next.
export async function prepare(beNo, { company, masters = {}, fetched = null } = {}) {
  const code = companyCode(company);
  const problems = [], warnings = [];
  if (!code) problems.push(`the open company "${company}" is neither Headphone Zone nor Ferrari Video`);
  const { boe, items, links, aliases } = fetched || await fetchBoe(beNo);   // fetched: tests only
  const importerCode = companyCode(boe.importer_name);
  if (code && importerCode && importerCode !== code) problems.push(`this BOE was imported by ${boe.importer_name}, but Tally has ${company} open`);
  if (!(Number(boe.exchange_rate) > 0)) problems.push('the BOE has no exchange rate');
  if (!boe.be_date) problems.push('the BOE has no BE date');
  if (!items.length) problems.push('the BOE has no item lines');

  const template = await importTemplate(company);
  if (!template) problems.push('no import purchase (narration naming a BOE) in the last 180 days of this company to copy ledgers and godown from');

  const stock = masters.items || new Set(await listStockItemNames());
  const stockByKey = new Map([...stock].map((n) => [itemKey(n), n]));
  const inStock = (name) => (stock.has(name) ? name : stockByKey.get(itemKey(name)) || null);

  // Party ledger: saved pick, else a unique match on the supplier name.
  const ledgersByLower = masters.ledgers || await supplierLedgerNames();   // suppliers (Sundry Creditors) only
  let party = savedParty(code, boe.supplier_name), partySource = 'saved';
  if (party && !ledgersByLower.has(party.toLowerCase())) { warnings.push(`the ledger picked before for this supplier ("${party}") no longer exists`); party = null; }
  if (!party) {
    const want = partyKey(boe.supplier_name);
    const hits = [...ledgersByLower.values()].filter((n) => partyKey(n) === want);
    if (hits.length === 1) { party = hits[0]; partySource = 'name'; }
    else { partySource = 'none'; problems.push(hits.length > 1 ? `several ledgers match the supplier "${boe.supplier_name}" — pick one` : `no ledger matches the supplier "${boe.supplier_name}" — pick one`); }
  }

  // Lines.
  const rate = Number(boe.exchange_rate) || 0;
  const lines = items.map((i) => {
    const qty = Number(i.qty) || 0, price = Number(i.unit_price_usd) || 0;
    const line = { key: `${i.invsno}-${i.itemsn}`, invsno: i.invsno, itemsn: i.itemsn, description: i.description, cth: i.cth,
      qty, uqc: i.uqc, price, amount: round2(qty * price), tally: [], source: 'none' };
    const myLinks = links.filter((l) => l.invsno === i.invsno && l.itemsn === i.itemsn && l.company === code);
    const linked = myLinks.map((l) => ({ item: inStock(l.tally_item), wanted: l.tally_item, qty: Number(l.tally_qty) || 0 }));
    if (linked.length && linked.every((l) => l.item)) {
      const sum = linked.reduce((s, l) => s + l.qty, 0);
      // A split keeps its quantities only if they add up to the BOE line; otherwise it is one item.
      line.tally = linked.length > 1 && Math.abs(sum - qty) < 1e-6
        ? linked.map((l) => ({ item: l.item, qty: l.qty, amount: round2(l.qty * price) }))
        : [{ item: linked[0].item, qty, amount: line.amount }];
      line.source = 'link';
      return line;
    }
    const al = [...new Set(aliases.filter((a) => a.desc_key === mapKey(i.description)).map((a) => inStock(a.tally_item)).filter(Boolean))];
    if (al.length === 1) { line.tally = [{ item: al[0], qty, amount: line.amount }]; line.source = 'alias'; return line; }
    const saved = savedItem(code, boe.supplier_name, i.description);
    if (saved && inStock(saved)) { line.tally = [{ item: inStock(saved), qty, amount: line.amount }]; line.source = 'saved'; return line; }
    line.options = al;   // several portal aliases: offered first in the picker
    return line;
  });
  const unmatched = lines.filter((l) => !l.tally.length).length;
  if (unmatched) problems.push(`${unmatched} line(s) have no Tally stock item yet — pick them below`);
  const odd = [...new Set(lines.map((l) => String(l.uqc || '').toUpperCase()).filter((u) => u && !['NOS', 'PCS', 'U', 'UNT', 'NO'].includes(u)))];
  if (odd.length) warnings.push(`unit ${odd.join(', ')} on the BOE — posted as Nos; check the quantities`);

  // Freight: what the supplier's invoice adds on top of the goods.
  const itemsUsd = round2(lines.reduce((s, l) => s + l.amount, 0));
  const invoiceUsd = round2(Number(boe.inv_value_usd) || itemsUsd);
  const freightUsd = round2(invoiceUsd - itemsUsd);
  let freight = null;
  if (freightUsd > 0.009) {
    freight = { usd: freightUsd, ledger: template?.freightLedger || 'Shipping Charges (Imports)' };
  } else if (freightUsd < -0.009) {
    problems.push(`the items add up to $${itemsUsd.toFixed(2)}, more than the invoice value $${invoiceUsd.toFixed(2)} — check the BOE`);
  }

  // Masters that must already exist.
  if (template) {
    const need = [template.purchaseLedger, freight?.ledger].filter(Boolean);
    const have = await existingLedgers(need);
    for (const l of need) if (!have.has(l)) problems.push(`ledger "${l}" not found in Tally`);
    const godowns = masters.godowns || await listGodowns();
    if (!godowns.includes(template.godown)) problems.push(`godown "${template.godown}" not found in Tally`);
  }

  const existing = await existingFor(boe, party);
  const mine = postedBoe(code, boe.be_no);
  if (existing.length) problems.push(`already in Tally: ${existing.map((x) => `${x.type} ${x.number} of ${dmy(x.date)}`).join(', ')}`);
  else if (mine) problems.push(`posted from this app before as voucher ${mine.voucher_number} — but it is no longer in Tally; check before posting again`);

  const narration = `BOE no: ${boe.be_no}  BE dt: ${boe.be_date ? dmy(ymd(boe.be_date)) : ''}  USD $${invoiceUsd.toFixed(2)}   ₹${rate}`;
  return {
    company, code, boe, template, party, partySource, lines, freight, narration, existing, posted: mine || null,
    totals: { itemsUsd, freightUsd: freight ? freightUsd : 0, invoiceUsd, rate, inr: round2(invoiceUsd * rate) },
    problems, warnings, ready: problems.length === 0,
    masters: { items: stock, ledgers: ledgersByLower },
  };
}

// --- the voucher -------------------------------------------------------------------------------------
// Foreign-currency amount, written the way Tally prints it ("-$5397.30 @ Rs. 96.2159/$"): Tally's import
// reads its own notation back. UNPROVEN until the first test posting — PURCHASE_POSTING must stay off
// until a voucher posted from here has been read back and compared with a hand-entered one.
const fx = (usd, rate) => `${usd < 0 ? '-' : ''}$${Math.abs(usd).toFixed(2)} @ Rs. ${rate}/$`;
const nos = (q) => `${Number(q)} Nos`;

export function buildPurchaseVoucher(p) {
  const { boe, template: t, party, lines, freight, narration, totals } = p;
  const date = ymd(boe.be_date), rate = totals.rate;
  const ledgerentries = [
    { ledgername: party, isdeemedpositive: false, ispartyledger: true, amount: fx(totals.invoiceUsd, rate),
      billallocations: [{ name: String(boe.inv_no || boe.be_no), billtype: 'New Ref', amount: fx(totals.invoiceUsd, rate) }] },
    ...(freight ? [{ ledgername: freight.ledger, isdeemedpositive: true, ispartyledger: false, amount: fx(-freight.usd, rate) }] : []),
  ];
  const allinventoryentries = lines.flatMap((l) => l.tally.map((x) => ({
    stockitemname: x.item, isdeemedpositive: true,
    rate: `$${l.price}/Nos`, amount: fx(-x.amount, rate), actualqty: nos(x.qty), billedqty: nos(x.qty),
    batchallocations: [{ godownname: t.godown, batchname: t.batch, amount: fx(-x.amount, rate), actualqty: nos(x.qty), billedqty: nos(x.qty) }],
    accountingallocations: [{ ledgername: t.purchaseLedger, isdeemedpositive: true, amount: fx(-x.amount, rate) }],
  })));
  return {
    metadata: { type: 'Voucher', vchtype: t.voucherType, action: 'Create', objview: 'Invoice Voucher View' },
    date, effectivedate: date, referencedate: date,
    vouchertypename: t.voucherType, ...(t.className ? { classname: t.className } : {}),
    persistedview: 'Invoice Voucher View', vchentrymode: 'Item Invoice', isinvoice: true,
    narration, reference: String(boe.inv_no || ''),
    partyname: party, partyledgername: party, basicbasepartyname: party,
    placeofsupply: t.placeOfSupply || '', consigneecountryname: t.consigneeCountry || 'India',
    consigneestatename: t.consigneeState || '', consigneemailingname: t.consigneeName || '', consigneegstin: t.consigneeGstin || '',
    ledgerentries, allinventoryentries,
  };
}

// Read-back: the voucher posted for this BOE (narration names it), compared with what was sent.
export async function readBack(p) {
  const date = ymd(p.boe.be_date);
  const re = new RegExp(`(^|\\D)${p.boe.be_no}(\\D|$)`);
  const found = (await purchaseVouchersInRange(date, date)).filter((v) => !v.cancelled && re.test(v.narration));
  if (found.length !== 1) return { voucher: null, checks: [found.length ? `${found.length} vouchers name this BOE — check Tally` : 'not found in Tally after import'] };
  const v = await readPurchaseVoucher(found[0].masterId, found[0].date);
  const checks = [];
  const partyLine = v.ledgers.find((l) => l.isParty);
  if (v.party !== p.party) checks.push(`party is "${v.party}"`);
  if (!partyLine || Math.abs((partyLine.fx ?? 0) - p.totals.invoiceUsd) > 0.02) checks.push(`party amount is ${partyLine?.fx ?? 'missing'} USD, expected ${p.totals.invoiceUsd}`);
  if (partyLine && Math.abs((partyLine.rate ?? 0) - p.totals.rate) > 0.00005) checks.push(`exchange rate is ${partyLine.rate}, expected ${p.totals.rate}`);
  const sent = p.lines.reduce((s, l) => s + l.tally.length, 0);
  if (v.items.length !== sent) checks.push(`${v.items.length} item line(s), expected ${sent}`);
  return { voucher: v, checks };
}
