// Missing Invoice tab: skipped voucher numbers in a series, checked against Unicommerce.
//
// Same logic as Desktop\Missing Invoice\gap-ledger.html (Gap Ledger), moved to the server:
//   1. Every Sales-class voucher in the range is read from Tally (number, date, type, cancelled).
//   2. Pick a voucher type (Sales by default) and a series. A series is the number's prefix up to
//      its 4-digit year code, so HPZPL2627- and HPZPL2627-M are both series "HPZPL2627" (each still
//      gap-checked on its own numbering). Default: the biggest series carrying the From date's
//      financial-year code (2627).
//   3. Per prefix, every number between the lowest and highest that Tally does not hold is a gap.
//      Not counted: a prefix with fewer than 2 numbers, a range over 2,000,000, or one where under
//      10% of the numbers are present (an older series that mostly lives outside these dates).
//   4. A gap whose number Tally holds under ANOTHER voucher type (e.g. UniCommerce Sales) is a used
//      number, not a gap. A voucher cancelled in Tally keeps its number, so it is listed apart.
//   5. Every gap and Tally-cancelled number is looked up in Unicommerce by invoice code. Cancelled
//      there (order or package CANCELLED) -> "Cancelled in Unicommerce"; otherwise a gap is TRULY
//      MISSING. A missing number takes the month and zero-padding of the voucher before it.
//
// Two fixes over the Gap Ledger, both found on live data (1 Aug - 20 Oct 2026):
//   a. A prefix is compared WITHOUT spaces: "HPZPL2627-M" and "HPZPL2627 - M" are one numbering
//      typed two ways, and each one's numbers filled the other's "gaps" (~285 false gaps).
//   b. A run of more than BIG_GAP consecutive missing numbers is the edge of the date range, not
//      missing invoices: one old number (HPZPL2627-00025) dated in October made 26-111,657 — every
//      invoice before August — "missing". Such a run is not counted; it is shown on the series line.
//      Real gaps there were runs of 1-2. The 10% rule is then applied to the numbers left in range.

import * as uc from './uc.mjs';

export const MAX_DAYS = 400;              // a whole financial year fits
const MAX_RANGE = 2000000;                // safety cap on one prefix's min..max
const BIG_GAP = 50;                       // longer runs of missing numbers = outside the date range
const UC_MAX = 30000;                     // ~16 lookups a second: about half an hour at most
const UC_CACHE_MS = 6 * 3600e3;           // a status can change (an order cancelled later)
const TRAILING_NUM = /^(.*?)(\d+)\s*$/;

const ucCache = new Map();                // invoice -> { at, r }

// [from, to] ISO dates -> calendar-month pieces as [yyyymmdd, yyyymmdd] (one Tally request each).
export function monthChunks(from, to) {
  const out = [];
  let cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const stop = monthEnd < end ? monthEnd : end;
    const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    out.push([ymd(cur), ymd(stop)]);
    cur = new Date(stop.getTime() + 864e5);
  }
  return out;
}

// Financial-year code of the From date: 2026-04-01 -> "2627".
export function fyCode(from) {
  const d = new Date(`${from}T00:00:00Z`);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');
}

export function seriesKey(prefix) {
  const m = /^(.*?\d{4})/.exec(prefix);
  return (m ? m[1] : prefix).replace(/[-/ ]+$/, '');
}

function groupAndFindGaps(rows) {
  // key (prefix without spaces) -> { spellings: prefix -> count, info: num -> {id,date,width,prefix}, tallyCancelled, rawCount }
  const buckets = new Map();
  let unparsed = 0;
  for (const r of rows) {
    const m = r.no.match(TRAILING_NUM);
    if (!m) { unparsed++; continue; }
    const [, prefix, digits] = m;
    const key = prefix.replace(/\s+/g, '');
    const num = parseInt(digits, 10);
    if (!buckets.has(key)) buckets.set(key, { spellings: new Map(), info: new Map(), tallyCancelled: new Map(), rawCount: 0 });
    const b = buckets.get(key);
    b.spellings.set(prefix, (b.spellings.get(prefix) || 0) + 1);
    if (!b.info.has(num)) b.info.set(num, { id: r.no, date: r.date, width: digits.length, prefix });
    if (r.cancelled) b.tallyCancelled.set(num, r.no);
    b.rawCount++;
  }

  const groups = [];
  for (const [, b] of buckets) {
    // Shown under its most common spelling; the others are listed so nobody wonders where they went.
    const spellings = [...b.spellings].sort((x, y) => y[1] - x[1]).map(([p]) => p);
    const prefix = spellings[0];
    const also = spellings.slice(1);
    const tallyCancelled = [...b.tallyCancelled].map(([num, id]) => ({ id, num, gap: false, tally: true, date: b.info.get(num).date }));
    if (b.info.size < 2) {
      groups.push({ prefix, also, tooSmall: true, count: b.rawCount, min: null, max: null, expected: b.rawCount, blocks: [], missing: tallyCancelled });
      continue;
    }
    const nums = [...b.info.keys()].sort((x, y) => x - y);
    const min = nums[0], max = nums[nums.length - 1], expected = max - min + 1;
    if (expected > MAX_RANGE) { groups.push({ prefix, also, tooLarge: true, count: b.info.size, min, max, expected, blocks: [], missing: tallyCancelled }); continue; }
    // Runs longer than BIG_GAP are outside the dates: set aside, then judge "sparse" on what is left.
    const blocks = [];
    for (let i = 0; i < nums.length - 1; i++) {
      if (nums[i + 1] - nums[i] - 1 > BIG_GAP) blocks.push({ from: nums[i] + 1, to: nums[i + 1] - 1, size: nums[i + 1] - nums[i] - 1 });
    }
    const inRange = expected - blocks.reduce((s, x) => s + x.size, 0);
    if (b.info.size < inRange * 0.1) { groups.push({ prefix, also, sparse: true, count: b.info.size, min, max, expected: inRange, blocks, missing: tallyCancelled }); continue; }
    const missing = tallyCancelled;
    for (let i = 0; i < nums.length - 1; i++) {
      if (nums[i + 1] - nums[i] - 1 > BIG_GAP) continue;
      const prev = b.info.get(nums[i]);
      for (let n = nums[i] + 1; n < nums[i + 1]; n++) {
        missing.push({ id: prev.prefix + String(n).padStart(prev.width, '0'), num: n, gap: true, tally: false, date: prev.date });
      }
    }
    missing.sort((x, y) => x.num - y.num);
    groups.push({ prefix, also, count: b.info.size, min, max, expected: inRange, blocks, missing });
  }
  groups.sort((a, b) => a.prefix.localeCompare(b.prefix));
  return { groups, unparsed };
}

async function lookupUnicommerce(ids, onProgress) {
  const now = Date.now();
  const todo = [...new Set(ids)].filter((id) => !(ucCache.get(id)?.at > now - UC_CACHE_MS));
  if (!todo.length) return '';
  if (!uc.configured()) return 'Unicommerce is not configured (UNICOMMERCE_* in .env) — gaps are not checked for cancellation there.';
  if (todo.length > UC_MAX) return `Unicommerce check skipped — ${todo.length.toLocaleString('en-IN')} numbers to look up (limit ${UC_MAX.toLocaleString('en-IN')}). Pick a single series rather than "All series".`;
  let next = 0, done = 0, failed = 0, lastErr = '';
  await Promise.all(Array.from({ length: 4 }, async () => {   // 4 at a time, like the Gap Ledger
    while (next < todo.length) {
      const id = todo[next++];
      try { ucCache.set(id, { at: Date.now(), r: await uc.lookupInvoice(id) }); }
      catch (err) { failed++; lastErr = err.message; }
      if (++done % 25 === 0) onProgress?.(`Looking up invoices in Unicommerce… ${done.toLocaleString('en-IN')} of ${todo.length.toLocaleString('en-IN')}`);
    }
  }));
  return failed ? `${failed} of ${todo.length} Unicommerce lookups failed (${lastErr.slice(0, 120)}). Fetch again to retry them.` : '';
}

const ddMonYyyy = (d) => (/^\d{8}$/.test(d || '')
  ? `${d.slice(6, 8)}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+d.slice(4, 6) - 1]}-${d.slice(0, 4)}` : d || '');

// Analyse the vouchers already read from Tally for one type and series (a series of '*' = all).
// Unicommerce only — never Tally — so the screen can switch type or series without re-reading Tally.
export async function analyze(base, { type, series, onProgress } = {}) {
  const counts = {};
  for (const v of base.vouchers) counts[v.type] = (counts[v.type] || 0) + 1;
  const types = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const pickType = types.includes(type) ? type
    : types.find((t) => /^sales$/i.test(t)) || types.find((t) => /sales/i.test(t)) || types[0] || '';
  const rows = base.vouchers.filter((v) => v.type === pickType);
  const withNo = rows.filter((v) => v.no);
  const all = groupAndFindGaps(withNo);

  const perSeries = new Map();
  for (const g of all.groups) perSeries.set(seriesKey(g.prefix), (perSeries.get(seriesKey(g.prefix)) || 0) + g.count);
  const seriesList = [...perSeries.keys()].sort((a, b) => perSeries.get(b) - perSeries.get(a))
    .map((k) => ({ key: k, count: perSeries.get(k) }));
  const fy = fyCode(base.from);
  const pickSeries = series === '*' || perSeries.has(series) ? series
    : (seriesList.find((s) => s.key.includes(fy)) || seriesList[0] || { key: '*' }).key;
  const groups = pickSeries === '*' ? all.groups : all.groups.filter((g) => seriesKey(g.prefix) === pickSeries);

  // Numbers of this series that Tally holds under another type are used numbers, not gaps.
  const other = new Map();
  for (const v of base.vouchers) if (v.type !== pickType && v.no && !other.has(v.no)) other.set(v.no, v.type);
  for (const g of groups) g.missing = g.missing.filter((m) => !(m.gap && other.has(m.id)));

  const ucNote = await lookupUnicommerce(groups.flatMap((g) => g.missing.map((m) => m.id)), onProgress);

  const list = [];
  for (const g of groups) {
    for (const m of g.missing) {
      const u = ucCache.get(m.id)?.r;
      const ucCancelled = Boolean(u) && (u.orderStatus === 'CANCELLED' || u.packageStatus === 'CANCELLED');
      list.push({
        id: m.id, series: g.prefix, month: ddMonYyyy(m.date).slice(3), date: m.date,
        status: m.tally ? 'tally' : ucCancelled ? 'uc' : 'missing',
        cancelledIn: [m.tally ? 'Tally' : '', ucCancelled ? 'Unicommerce' : ''].filter(Boolean).join(' / '),
        orderNo: u?.orderNo || '', ucStatus: !u ? '' : !u.found ? 'Not in Unicommerce' : `Order ${u.orderStatus || '?'} / Package ${u.packageStatus || '?'}`,
      });
    }
  }
  const summary = groups.map((g) => {
    const n = list.filter((x) => x.series === g.prefix);
    return { prefix: g.prefix, also: g.also || [], blocks: g.blocks || [], count: g.count, min: g.min, max: g.max, expected: g.expected,
      tooSmall: Boolean(g.tooSmall), tooLarge: Boolean(g.tooLarge), sparse: Boolean(g.sparse),
      missing: n.filter((x) => x.status === 'missing').length, cancelled: n.filter((x) => x.status !== 'missing').length };
  });
  return {
    type: pickType, types: types.map((t) => ({ type: t, count: counts[t] })),
    series: pickSeries, seriesList, groups: summary, rows: list,
    counts: { all: list.length, missing: list.filter((x) => x.status === 'missing').length,
      tally: list.filter((x) => x.status === 'tally').length, uc: list.filter((x) => x.status === 'uc').length },
    scanned: groups.reduce((s, g) => s + g.count, 0),
    skipped: pickSeries === '*' ? all.unparsed + (rows.length - withNo.length) : 0,
    ucNote,
  };
}
