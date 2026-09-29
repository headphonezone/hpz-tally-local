// Warranty-sheet feed. HPZMaterialOutFeed.gs already serves both tabs of both
// workbooks as JSON, so this app never touches Google credentials — it just
// fetches a public /exec URL. That script stays the source of truth for which
// rows qualify; do not re-implement row selection here.

import { tallyDateLiteral } from './tally.mjs';

const FEED_URL = process.env.HPZ_FEED_URL ||
  'https://script.google.com/macros/s/AKfycbx5G2uNT7ubDE-mo03a97vQqFz_3VFiejjsXVPZdXbudW68KTLYJ0Epe2I12dY2o4WI2A/exec';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Returns Tally's YYYYMMDD, or null when the cell will not parse. The sheet
// holds genuine garbage in this column (SLA targets like "2026-30-06"), and a
// row with no usable date must be dropped rather than guessed at.
export function toTallyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let y, m, d;

  let match = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2}|\d{4})$/);
  if (match) {
    d = +match[1];
    m = MONTHS[match[2].slice(0, 3).toLowerCase()];
    y = +match[3];
    if (y < 100) y += 2000;
  } else if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [, y, m, d] = match.map(Number);
  } else {
    return null;
  }

  if (!m || m < 1 || m > 12 || !d || d < 1 || d > 31 || !y || y < 2000 || y > 2100) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

// The Apps Script endpoint routinely takes 15-30s for a full book and
// intermittently drops the connection outright, so retries are not optional.
export async function fetchBook(book, { attempts = 4, from = null, to = null } = {}) {
  // The script windows on closure date and takes d-MMM-yyyy. Narrowing here is
  // what keeps the report from asking Tally about thousands of irrelevant rows.
  const params = new URLSearchParams({ book });
  if (from) params.set('fromdate', tallyDateLiteral(from));
  if (to) params.set('todate', tallyDateLiteral(to));

  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${FEED_URL}?${params}`, {
        signal: AbortSignal.timeout(150000),
      });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      const json = JSON.parse(await res.text());
      return (json.vch_dtls || []).map((r) => ({ ...r, tallyDate: toTallyDate(r.RDATE) }));
    } catch (err) {
      lastError = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`sheet feed failed after ${attempts} attempts: ${lastError.message}`);
}
