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
import { purchaseVouchersInRange, readPurchaseVoucher, existingLedgers, supplierLedgerNames, listGodowns, stockItemsDetailed, stockGroupsAndCategories } from './tally.mjs';

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
// Added 2026-10-21: whether the voucher was posted as Optional (provisional).
try { db.exec('ALTER TABLE posted ADD COLUMN optional INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }

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
  db.prepare(`INSERT INTO posted (company, be_no, voucher_number, voucher_date, master_id, party, amount_fx, rate, payload, checks, test_mode, created_at, optional)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company, be_no) DO UPDATE SET voucher_number = excluded.voucher_number, voucher_date = excluded.voucher_date,
      master_id = excluded.master_id, party = excluded.party, amount_fx = excluded.amount_fx, rate = excluded.rate, payload = excluded.payload,
      checks = excluded.checks, test_mode = excluded.test_mode, created_at = excluded.created_at, optional = excluded.optional`).run(row.company, row.be_no, row.voucher_number, row.voucher_date, row.master_id, row.party,
    row.amount_fx, row.rate, JSON.stringify(row.payload), JSON.stringify(row.checks || []), row.test_mode ? 1 : 0, new Date().toISOString(), row.optional ? 1 : 0);
}
export const listPosted = (limit = 200) => db.prepare('SELECT id, company, be_no, voucher_number, voucher_date, party, amount_fx, rate, checks, test_mode, optional, created_at FROM posted ORDER BY id DESC LIMIT ?')
  .all(Math.min(Number(limit) || 200, 1000)).map((r) => ({ ...r, checks: JSON.parse(r.checks || '[]'), test_mode: Boolean(r.test_mode), optional: Boolean(r.optional) }));

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
  // Tally items already imported under the same customs codes (any supplier) -> a new item's group.
  const cthItems = {};
  try {
    const cths = [...new Set(items.map((i) => String(i.cth || '').trim()).filter(Boolean))];
    if (cths.length) for (const r of await boeDb.selectIn('tally_item_map', 'cth,tally_item', 'cth', cths, '&limit=2000')) (cthItems[r.cth] ||= []).push(r.tally_item);
  } catch { /* no item map */ }
  return { boe, items, links, aliases, cthItems };
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
  // The freight ledger: a ledger NAMED for freight on a recent import voucher. Only by name — on Ferrari
  // Video the "other" ledger found on an older voucher was "Purchase GST" (2026-10-21), not freight.
  const isFreight = (l) => !l.isParty && /freight|shipping|courier|transport/i.test(l.ledger);
  let freightLedger = v.ledgers.find(isFreight)?.ledger || null;
  for (const o of list.slice(0, -1).reverse().slice(0, 15)) {
    if (freightLedger) break;
    const w = await readPurchaseVoucher(o.masterId, o.date);
    freightLedger = w?.ledgers.find(isFreight)?.ledger || null;
  }
  if (!freightLedger) freightLedger = 'Shipping Charges (Imports)';   // checked to exist before posting
  const t = {
    from: `voucher ${v.number} of ${dmy(v.date)} (${v.party})`,
    voucherType: v.type, className: v.className, purchaseLedger, freightLedger,
    godown: v.items[0].godown, batch: v.items[0].batch || 'Primary Batch',
    placeOfSupply: v.placeOfSupply, consigneeCountry: v.consigneeCountry || 'India', consigneeState: v.consigneeState,
    consigneeName: v.consigneeName, consigneeGstin: v.consigneeGstin,
  };
  templateCache.set(company, { at: Date.now(), t, list });
  return t;
}

// The currency a supplier invoices in: the symbol on its latest import voucher in Tally (the BOE portal
// does not record the currency, and supplier ledgers are all in Rs.). A supplier never imported from
// before: USD when the BOE rate looks like a dollar rate, otherwise unknown and the BOE is blocked.
const CURRENCY_CODE = { '$': 'USD', 'U$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', 'S$': 'SGD', 'HK$': 'HKD', 'A$': 'AUD', 'C$': 'CAD', '¥': 'JPY', 'CNY': 'CNY', 'RMB': 'CNY' };
const currencyCache = new Map();   // company|party -> { sym, from }
async function currencyFor(company, party, rate) {
  const k = `${company}|${party}`;
  if (currencyCache.has(k)) return currencyCache.get(k);
  await importTemplate(company);
  const list = templateCache.get(company)?.list || [];
  let found = null;
  for (const v of list.filter((x) => x.party === party).reverse().slice(0, 3)) {
    const w = await readPurchaseVoucher(v.masterId, v.date);
    const sym = w?.ledgers.find((l) => l.isParty)?.sym;
    if (sym) { found = { sym, from: `voucher ${w.number} of ${dmy(w.date)}` }; break; }
  }
  if (!found) {
    found = rate >= 80 && rate <= 110
      ? { sym: '$', from: null, assumed: true }   // first import from this supplier, dollar-like rate
      : { sym: null, from: null };
  }
  found.code = CURRENCY_CODE[found.sym] || found.sym;
  if (found.from) currencyCache.set(k, found);
  return found;
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
    .map((v) => ({ number: v.number, date: v.date, type: v.type, party: v.party, narration: v.narration, reference: v.reference, optional: v.optional }));
}

// --- prepare: everything the screen shows, and everything Post re-checks -------------------------------
// `masters` lets one request share the slow lookups (all ledgers, all stock items) with the next.
// `choices`: what the screen says per line — { [key]: { useBoe, name, group, category } }. useBoe = the tick
// "the BOE name is right": the line goes in under the BOE description (editable). No tick = the name typed
// or picked. Either one is enough. A name not yet in Tally is a NEW stock item, created on Post.
export async function prepare(beNo, { company, masters = {}, fetched = null, choices = {} } = {}) {
  const code = companyCode(company);
  const problems = [], warnings = [];
  if (!code) problems.push(`the open company "${company}" is neither Headphone Zone nor Ferrari Video`);
  const { boe, items, links, aliases, cthItems = {} } = fetched || await fetchBoe(beNo);   // fetched: tests only
  const importerCode = companyCode(boe.importer_name);
  if (code && importerCode && importerCode !== code) problems.push(`this BOE was imported by ${boe.importer_name}, but Tally has ${company} open`);
  if (!(Number(boe.exchange_rate) > 0)) problems.push('the BOE has no exchange rate');
  if (!boe.be_date) problems.push('the BOE has no BE date');
  if (!items.length) problems.push('the BOE has no item lines');

  const template = await importTemplate(company);
  if (!template) problems.push('no import purchase (narration naming a BOE) in the last 180 days of this company to copy ledgers and godown from');

  // Stock items with their group and brand (to suggest them for a new item), and the group / category masters.
  if (!masters.detail) {
    const all = await stockItemsDetailed();
    masters.detail = new Map(all.map((i) => [i.name, i]));
    masters.items = new Set(all.map((i) => i.name));
  }
  if (!masters.groups) Object.assign(masters, await stockGroupsAndCategories());
  const stock = masters.items, detail = masters.detail;
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

  // What the screen says wins: the ticked BOE name, or the name typed / picked.
  for (const line of lines) {
    const c = choices[line.key];
    if (!c) continue;
    line.useBoe = Boolean(c.useBoe);
    const name = String(c.name ?? '').trim();
    if (name) {
      const same = line.tally.length === 1 && line.tally[0].item === (inStock(name) || name);
      if (!same) { line.tally = [{ item: inStock(name) || name, qty: line.qty, amount: line.amount }]; line.source = c.useBoe ? 'boe' : 'typed'; }
    } else if (c.cleared) { line.tally = []; line.source = 'none'; }
  }

  // Suggestions for a new item. Group: what existing items with the same customs code (CTH) sit under —
  // via the portal's item map. Brand: a category whose name appears in the description, else the brand of
  // this BOE's other lines.
  const cthGroup = new Map();
  for (const [cth, names] of Object.entries(cthItems)) {
    const tally = {};
    for (const n of names) { const g = detail.get(n)?.parent; if (g) tally[g] = (tally[g] || 0) + 1; }
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (best) cthGroup.set(cth, best[0]);
  }
  const lineBrands = {};
  for (const l of lines) for (const x of l.tally) { const c = detail.get(inStock(x.item) || '')?.category; if (c) lineBrands[c] = (lineBrands[c] || 0) + 1; }
  const boeBrand = Object.entries(lineBrands).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const brandIn = (text) => {
    const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ')} `;
    return masters.categories.filter((c) => c.length > 2 && t.includes(` ${c.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()} `))
      .sort((a, b) => b.length - a.length)[0] || '';
  };

  // Every line carries the suggestion, so the screen can offer it for whatever new name is typed.
  for (const line of lines) line.suggest = { group: cthGroup.get(String(line.cth || '')) || '', category: brandIn(line.description) || boeBrand };

  const newItems = [];
  for (const line of lines) {
    for (const x of line.tally) {
      const canon = inStock(x.item);
      x.exists = Boolean(canon);
      if (canon) x.item = canon;
    }
    const fresh = line.tally.find((x) => !x.exists);
    if (!fresh) continue;
    const c = choices[line.key] || {};
    const suggested = { group: cthGroup.get(String(line.cth || '')) || '', category: brandIn(fresh.item) || brandIn(line.description) || boeBrand };
    line.newItem = { name: fresh.item, group: c.group || suggested.group, category: c.category || suggested.category, suggested };
    const bad = [];
    if (/["\r\n]/.test(fresh.item)) bad.push('the name has a double quote or line break');
    if (fresh.item.length > 200) bad.push('the name is over 200 characters');
    if (!line.newItem.group) bad.push('pick its stock group'); else if (!masters.groups.includes(line.newItem.group)) bad.push(`group "${line.newItem.group}" is not in Tally`);
    if (!line.newItem.category) bad.push('pick its brand (category)'); else if (!masters.categories.includes(line.newItem.category)) bad.push(`brand "${line.newItem.category}" is not in Tally`);
    if (bad.length) problems.push(`line ${line.invsno}/${line.itemsn} — new item "${fresh.item}": ${bad.join(', ')}`);
    newItems.push(line.newItem);
  }
  const unmatched = lines.filter((l) => !l.tally.length);
  if (unmatched.length) problems.push(`${unmatched.length} line(s) need a name: tick the BOE name, or give the Tally stock item name (${unmatched.map((l) => `${l.invsno}/${l.itemsn}`).join(', ')})`);
  if (newItems.length) warnings.push(`${newItems.length} new stock item(s) will be created in Tally when you post: ${newItems.map((n) => `"${n.name}"`).join(', ')}`);
  const odd = [...new Set(lines.map((l) => String(l.uqc || '').toUpperCase()).filter((u) => u && !['NOS', 'PCS', 'U', 'UNT', 'NO'].includes(u)))];
  if (odd.length) warnings.push(`unit ${odd.join(', ')} on the BOE — posted as Nos; check the quantities`);

  // Only the invoice value goes in (decided 2026-10-21): supplier Cr invoice value, items Dr at their invoice
  // prices — no freight, GST, duty or any other ledger. So the items must add up to the invoice value; a
  // BOE whose items don't is blocked with the difference rather than parking it in another ledger.
  const itemsUsd = round2(lines.reduce((s, l) => s + l.amount, 0));
  const invoiceUsd = round2(Number(boe.inv_value_usd) || itemsUsd);
  const freight = null;
  if (Math.abs(invoiceUsd - itemsUsd) > 0.009) {
    problems.push(`the items add up to ${itemsUsd.toFixed(2)} but the invoice value is ${invoiceUsd.toFixed(2)} (difference ${round2(invoiceUsd - itemsUsd).toFixed(2)}) — only the invoice value is posted, so the lines must match it; check the BOE`);
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
  if (existing.length) problems.push(`already in Tally: ${existing.map((x) => `${x.type} ${x.number} of ${dmy(x.date)}${x.optional ? ' (Optional)' : ''}`).join(', ')}`);
  // Posted from here before but gone from Tally (deleted after a wrong posting): a warning, so it can be posted again.
  else if (mine) warnings.push(`posted from this app before as voucher ${mine.voucher_number}, which is no longer in Tally (deleted?) — posting again creates a new voucher`);

  // Currency of the invoice (see currencyFor).
  let currency = { sym: null, code: null, from: null };
  if (party) {
    currency = await currencyFor(company, party, rate);
    if (!currency.sym) problems.push(`currency unknown: no earlier import from ${party} in Tally, and the BOE rate ₹${rate} does not look like a dollar rate`);
    else if (currency.assumed) warnings.push(`first import from ${party} in the last 180 days — currency assumed USD (rate ₹${rate}); check the invoice`);
  }

  // As accounts write it: "USD $10666" whatever the company calls the currency (Ferrari Video: U$).
  const narration = `BOE no: ${boe.be_no}  BE dt: ${boe.be_date ? dmy(ymd(boe.be_date)) : ''}  ${currency.code || ''} ${currency.code === 'USD' ? '$' : currency.sym || ''}${invoiceUsd.toFixed(2)}   ₹${rate}`;
  return {
    company, code, boe, template, party, partySource, currency, lines, freight, narration, existing, posted: mine || null,
    totals: { itemsUsd, freightUsd: freight ? freightUsd : 0, invoiceUsd, rate, inr: round2(invoiceUsd * rate) },
    newItems, groups: masters.groups, categories: masters.categories,
    problems, warnings, ready: problems.length === 0,
    masters: { ...masters, ledgers: ledgersByLower },
  };
}

// A new stock item, the way the existing ones are set up (read off "64 Audio - 2Pin - 3.5mm - with Mic -
// Cable - Accessory", 2026-10-21): group + brand category, unit Nos, GST "as per company / stock group",
// so HSN and rate come from the group. UNPROVEN as a JSON import until the first test posting.
export function buildStockItem({ name, group, category }) {
  return {
    metadata: { type: 'StockItem', name, action: 'Create' },
    name, parent: group, category, baseunits: 'Nos',
    gstapplicable: 'Applicable', gsttypeofsupply: 'Goods',
  };
}

// --- the voucher -------------------------------------------------------------------------------------
// Foreign-currency amount, written the way Tally prints it ("-$5397.30 @ Rs. 96.2159/$"): Tally's import
// reads its own notation back. UNPROVEN until the first test posting — PURCHASE_POSTING must stay off
// until a voucher posted from here has been read back and compared with a hand-entered one.
const nos = (q) => `${Number(q)} Nos`;

// optional: posted as an Optional voucher (Tally's "Mark as Optional", Ctrl+L) — saved and visible, but it
// affects neither the books nor stock until someone makes it regular in Tally.
export function buildPurchaseVoucher(p, { optional = false } = {}) {
  const { boe, template: t, party, lines, freight, narration, totals } = p;
  const date = ymd(boe.be_date), rate = totals.rate, sym = p.currency.sym;
  if (!sym) throw new Error('the invoice currency is unknown');
  const fx = (amt) => `${amt < 0 ? '-' : ''}${sym}${Math.abs(amt).toFixed(2)} @ Rs. ${rate}/${sym}`;
  const ledgerentries = [
    { ledgername: party, isdeemedpositive: false, ispartyledger: true, amount: fx(totals.invoiceUsd),
      billallocations: [{ name: String(boe.inv_no || boe.be_no), billtype: 'New Ref', amount: fx(totals.invoiceUsd) }] },
    ...(freight ? [{ ledgername: freight.ledger, isdeemedpositive: true, ispartyledger: false, amount: fx(-freight.usd) }] : []),
  ];
  const allinventoryentries = lines.flatMap((l) => l.tally.map((x) => ({
    stockitemname: x.item, isdeemedpositive: true,
    rate: `${sym}${l.price}/Nos`, amount: fx(-x.amount), actualqty: nos(x.qty), billedqty: nos(x.qty),
    batchallocations: [{ godownname: t.godown, batchname: t.batch, amount: fx(-x.amount), actualqty: nos(x.qty), billedqty: nos(x.qty) }],
    accountingallocations: [{ ledgername: t.purchaseLedger, isdeemedpositive: true, amount: fx(-x.amount) }],
  })));
  return {
    metadata: { type: 'Voucher', vchtype: t.voucherType, action: 'Create', objview: 'Invoice Voucher View' },
    date, effectivedate: date, referencedate: date,
    vouchertypename: t.voucherType, ...(t.className ? { classname: t.className } : {}),
    persistedview: 'Invoice Voucher View', vchentrymode: 'Item Invoice', isinvoice: true, ...(optional ? { isoptional: true } : {}),
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
  if (p._optional !== undefined && v.optional !== p._optional) checks.push(v.optional ? 'it is Optional in Tally, but was sent as regular' : 'it is a regular voucher in Tally, but was sent as Optional — it affects the books');
  const sent = p.lines.reduce((s, l) => s + l.tally.length, 0);
  if (v.items.length !== sent) checks.push(`${v.items.length} item line(s), expected ${sent}`);
  return { voucher: v, checks };
}
