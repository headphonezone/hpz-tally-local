// Client for RMS's /api/stock-journal-link — the one connection between RMS and Stock Journals.
//
// Ordinary outbound HTTPS from this PC to RMS on Cloud Run, authenticated with RMS's AGENT_SECRET
// (the same scheme the NVR agent uses). RMS never has to reach into the office, so no tunnel.
// These calls go to RMS, not Tally, so they deliberately do NOT pass through the Tally queue.

const BASE = (process.env.RMS_API_URL || '').replace(/\/+$/, '');
const SECRET = process.env.RMS_AGENT_SECRET || '';

export const configured = () => Boolean(BASE && SECRET);

async function call(path, { method = 'GET', body } = {}) {
  if (!configured()) throw new Error('RMS link is not configured — set RMS_API_URL and RMS_AGENT_SECRET in .env');
  let res;
  try {
    res = await fetch(`${BASE}/api/stock-journal-link${path}`, {
      method,
      headers: { 'x-agent-secret': SECRET, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`RMS unreachable: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `RMS HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

export const search = (type, q) => call(`/search?${new URLSearchParams({ type, q })}`);
export const lookup = (type, ref) => call(`/lookup?${new URLSearchParams({ type, ref })}`);

// Called only after the voucher is confirmed in Tally. Items are addressed by rma_number.
export const record = (voucher_number, godown, rma_numbers) =>
  call('/record', { method: 'POST', body: { voucher_number, godown, rma_numbers } });
