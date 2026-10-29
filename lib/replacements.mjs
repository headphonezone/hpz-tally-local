// WCID replacements on the Material Out tab (from 2026-10-29).
//
// A WCID unit comes in on a Material In to the Service Godown. When the customer gets a replacement, that
// unit's Material Out (<WCID>_MO) is the unit actually sent, from the godown it left (Service Godown or
// Chennai), as "Unboxed - <item>" when an unboxed unit was sent; the narration names the WCID and the
// customer's own product. The WCID unit itself goes Service Godown → Def on a Stock Journal (Stock Journal
// tab, from RMS Movement of Stock). RMS says which WCIDs were replaced and with what (/replacement-outs).
//
// Without an RMS replacement entry a row keeps the Material In's own item, as before: a repaired unit goes
// back as itself. A WCID that RMS knows was decided as a replacement but has no entry yet (`awaiting`) is
// held, so it can't go out as the customer's own product.
import { destName } from './stockjournal.mjs';

const lower = (s) => String(s || '').trim().toLowerCase();
const wsNorm = (s) => String(s).replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

// `units`: Tally stock item name -> base unit (tally.stockItemUnits). `alias`: RMS name -> the Tally item an
// operator chose for it on the Stock Journal tab (store.getAlias), or null.
export function resolveItem(name, unboxed, units, alias = () => null) {
  const byNorm = new Map([...units.keys()].map((n) => [wsNorm(n), n]));
  const find = (n) => (units.has(n) ? n : byNorm.get(wsNorm(n)) || null);
  const own = find(destName(name, unboxed));
  if (own) return own;
  const chosen = alias(name);
  return chosen ? find(destName(chosen, unboxed)) : null;
}

// Rewrites the report's rows in place: `out` (what the Material Out carries) and `replacement` (for the
// screen and the RMS write-back) on replaced WCIDs, or a block. Returns how many rows it changed.
export function applyReplacements(report, { replacements = [], awaiting = [], units, alias } = {}) {
  const byWcid = new Map(replacements.map((r) => [lower(r.wcid), r]));
  const waiting = new Set(awaiting.map(lower));
  let changed = 0;
  for (const row of report.rows) {
    if (row.status === 'done') continue;
    const r = byWcid.get(lower(row.wcid));
    if (!r) {
      if (waiting.has(lower(row.wcid)) && row.status === 'ready') {
        row.status = 'blocked';
        row.reason = 'replaced, but the replacement is not logged in RMS Movement of Stock yet: log it there, so the Material Out carries the unit actually sent';
        changed++;
      }
      continue;
    }
    const item = resolveItem(r.item_sent, r.sent_unboxed, units, alias);
    const unit = item && String(units.get(item) || '').trim();
    const same = lower(r.item_sent) === lower(r.item_received) && !r.sent_unboxed;
    row.replacement = {
      movementId: r.movement_id, condition: r.condition, sent: item || destName(r.item_sent, r.sent_unboxed),
      received: r.item_received, godown: r.send_godown, sourceRefNo: r.source_ref_no || '', materialOutNo: r.material_out_no || '',
    };
    changed++;
    if (!item) {
      if (row.status === 'ready') { row.status = 'blocked'; row.reason = `replacement sent "${destName(r.item_sent, r.sent_unboxed)}" is not a Tally item`; }
      continue;
    }
    if (!unit || /not applicable/i.test(unit)) {
      if (row.status === 'ready') { row.status = 'blocked'; row.reason = `replacement sent "${item}" has no unit in Tally`; }
      continue;
    }
    row.out = {
      stockItem: item,
      qty: ` 1.0 ${unit}`,
      godown: r.send_godown,
      batchName: 'Primary Batch',
      narration: [row.mi?.narration, `Replacement for ${row.wcid}: sent ${item} from ${r.send_godown}`
        + (same ? '' : ` (customer's unit: ${r.item_received})`) + (r.source_ref_no ? `, RET ${r.source_ref_no}` : '')]
        .filter(Boolean).join(' | '),
    };
  }
  report.counts = { ready: 0, done: 0, blocked: 0 };
  for (const row of report.rows) report.counts[row.status]++;
  return changed;
}
