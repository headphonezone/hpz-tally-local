// Supabase (PostgREST) clients.
//
// The default export set (sb, selectIn, upsert, configured) is the GST project, for the E-Way Bill /
// E-Invoice tabs. Supabase holds what Tally does not: who closed a document and why
// (gst_dispatch_log, gst_exception_close_log), which invoices came back (gst_returns), and the saved
// GSP portal checks (ewb_portal_check*). The same tables feed the 9am reminder mail, so a Close here
// is a Close everywhere.
//
// client() makes one for another project — the Purchase Import tab reads the BOE Costing Portal's
// own project (BOE_SUPABASE_URL / BOE_SUPABASE_KEY) through it.
//
// Service keys stay on this machine: the browser only ever talks to this app.

// A 401 "JWT issued at future" (PGRST303) and gateway hiccups are transient: Supabase now and then
// stamps its internal token a moment ahead of its own clock. The identical call succeeds seconds later.
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

// PostgREST in.(…) list. Every value double-quoted, so a voucher number with a comma, a dot or a
// bracket is read as one value.
export const inList = (vals) =>
  '(' + vals.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).map(encodeURIComponent).join(',') + ')';

export function client({ url, key, label = 'Supabase', missing = '' }) {
  const base = () => String(url() || '').replace(/\/+$/, '');
  const configured = () => Boolean(base() && key());

  async function sb(path, { method = 'GET', body, prefer } = {}) {
    if (!configured()) throw new Error(missing || `${label} is not configured`);
    const headers = { apikey: key(), Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(`${base()}/rest/v1/${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        if (attempt >= 3) throw new Error(`Cannot reach ${label}: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue;
      }
      const text = await res.text();
      if (res.ok) return text.trim() ? JSON.parse(text) : [];
      if (attempt < 3 && (TRANSIENT.has(res.status) || text.includes('PGRST303'))) {
        await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue;
      }
      const err = new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  }

  // SELECT … WHERE col IN (values), in chunks small enough for a URL (an IRN is 64 characters).
  async function selectIn(table, select, col, values, extra = '') {
    const out = [];
    const uniq = [...new Set(values.filter(Boolean).map(String))];
    for (let i = 0; i < uniq.length; i += 80) {
      out.push(...await sb(`${table}?select=${select}&${col}=in.${inList(uniq.slice(i, i + 80))}${extra}`));
    }
    return out;
  }

  // Upsert in chunks; existing rows are merged (only the columns sent change).
  async function upsert(table, rows, onConflict) {
    for (let i = 0; i < rows.length; i += 200) {
      await sb(`${table}?on_conflict=${onConflict}`, {
        method: 'POST', body: rows.slice(i, i + 200), prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }
  }

  return { configured, sb, selectIn, upsert };
}

// The GST project (E-Way Bill / E-Invoice tabs).
const gst = client({
  url: () => process.env.SUPABASE_URL, key: () => process.env.SUPABASE_SERVICE_KEY, label: 'Supabase',
  missing: 'Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env',
});
export const { configured, sb, selectIn, upsert } = gst;
