// Client for RMS's two links with this app: /api/stock-journal-link (Stock Journals) and
// /api/credit-note-link (Credit Notes (Goods Return)).
//
// Ordinary outbound HTTPS from this PC to RMS on Cloud Run, authenticated with RMS's AGENT_SECRET
// (the same scheme the NVR agent uses). RMS never has to reach into the office, so no tunnel.
// These calls go to RMS, not Tally, so they deliberately do NOT pass through the Tally queue.

const BASE = (process.env.RMS_API_URL || '').replace(/\/+$/, '');
const SECRET = process.env.RMS_AGENT_SECRET || '';

export const configured = () => Boolean(BASE && SECRET);

async function call(path, { method = 'GET', body, link = 'stock-journal-link', timeout = 20000 } = {}) {
  if (!configured()) throw new Error('RMS link is not configured — set RMS_API_URL and RMS_AGENT_SECRET in .env');
  let res;
  try {
    res = await fetch(`${BASE}/api/${link}${path}`, {
      method,
      headers: { 'x-agent-secret': SECRET, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`RMS unreachable: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `RMS HTTP ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

// --- Credit Notes (Goods Return) ---------------------------------------------------------------
// Good Returns with no credit note yet, grouped by order, for a received-date range (YYYY-MM-DD).
export const cnPending = (from, to) => call(`/pending?${new URLSearchParams({ from, to })}`, { link: 'credit-note-link' });
// Every Good Return row of one order plus RMS's Unicommerce detail (RMS calls Unicommerce: slower).
export const cnOrder = (orderNo) => call(`/order?${new URLSearchParams({ order_no: orderNo })}`, { link: 'credit-note-link', timeout: 60000 });
// After a VERIFIED posting: stamp the rows. RMS refuses (409) if a row already has another number.
export const cnRecord = (credit_note_no, credit_note_date, rma_numbers) =>
  call('/record', { method: 'POST', body: { credit_note_no, credit_note_date, rma_numbers }, link: 'credit-note-link' });

export const search = (type, q) => call(`/search?${new URLSearchParams({ type, q })}`);
export const lookup = (type, ref) => call(`/lookup?${new URLSearchParams({ type, ref })}`);

// Called only after the voucher is confirmed in Tally. Items are addressed by rma_number.
export const record = (voucher_number, godown, rma_numbers) =>
  call('/record', { method: 'POST', body: { voucher_number, godown, rma_numbers } });
