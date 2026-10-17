// TaxPro GSP — e-Way Bill API, READ ONLY (GetEwayBillsByDate). Nothing here generates or cancels.
//
// Every call is a PAID credit from a pool shared with e-Invoice, so:
//   - one login is reused for ~5 hours (data/gsp-token.json),
//   - every call — login or list, failed or not — is appended to data/gsp-calls.jsonl and counted,
//   - the caller (Check portal) pulls a day at most once; see lib/gst.mjs.
// The count covers calls made by THIS app only; the TaxPro CRM "API Transaction" page is the real balance.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TOKEN_FILE = join(DATA, 'gsp-token.json');
const LOG_FILE = join(DATA, 'gsp-calls.jsonl');
const HOSTS = ['https://einvapi.charteredinfo.com', 'https://einvapimum1.charteredinfo.com',
  'https://einvapidel2.charteredinfo.com'];   // TaxPro's own failover hosts
const TOKEN_LIFE_MS = 5 * 3600 * 1000;

const env = (k) => process.env[`TAXPRO_${k}`] || '';
export const configured = () => ['ASPID', 'ASPPWD', 'GSTIN', 'USERNAME', 'EWB_PWD'].every((k) => env(k));

function log(kind, ok, date = null) {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), kind, ok, date }) + '\n');
}

export function usage() {
  if (!existsSync(LOG_FILE)) return { total: 0, today: 0, since: null };
  const ev = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const istDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return { total: ev.length, today: ev.filter((e) => istDay(e.ts) === today).length, since: ev[0]?.ts || null };
}

// Query string as TaxPro expects it: '/' left as is in dates like 16/10/2026.
const qs = (params) => Object.entries(params)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2F/g, '/')}`).join('&');

async function call(path, params, kind, date = null) {
  let ok = false, last = null;
  try {
    for (const host of HOSTS) {
      let text;
      try {
        const res = await fetch(`${host}${path}?${qs(params)}`, { signal: AbortSignal.timeout(60000) });
        text = await res.text();
      } catch (err) { last = err; continue; }   // host down -> next host
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      ok = Array.isArray(body) || Boolean(body.authtoken || body.AuthToken);
      return body;
    }
    throw new Error(`GSP unreachable on every TaxPro host: ${last?.message || 'unknown error'}`);
  } finally {
    log(kind, ok, date);   // failed calls too — TaxPro may still charge them
  }
}

function savedToken() {
  try {
    const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    return t.exp > Date.now() ? t.token : null;
  } catch { return null; }
}

async function token(force = false) {
  const saved = !force && savedToken();
  if (saved) return saved;
  const r = await call('/v1.03/dec/auth', {
    action: 'ACCESSTOKEN', aspid: env('ASPID'), password: env('ASPPWD'), gstin: env('GSTIN'),
    username: env('USERNAME'), ewbpwd: env('EWB_PWD'),
  }, 'login');
  const tok = r.authtoken || r.AuthToken;
  if (!tok) throw new Error('e-Way Bill login failed: ' + JSON.stringify(r).slice(0, 200));
  mkdirSync(DATA, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({ token: tok, exp: Date.now() + TOKEN_LIFE_MS }));
  return tok;
}

const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Every e-Way Bill generated on one day (iso 'YYYY-MM-DD'). -> { rows, note }
// NIC answers a day with no bills with an error object, not [] — that becomes rows [] + its message.
export async function ewbsForDay(iso) {
  if (!configured()) throw new Error('TaxPro is not configured — set TAXPRO_* in .env');
  const list = async (tok) => call('/v1.03/dec/ewayapi', {
    action: 'GetEwayBillsByDate', aspid: env('ASPID'), password: env('ASPPWD'), gstin: env('GSTIN'),
    username: env('USERNAME'), authtoken: tok, date: ddmmyyyy(iso),
  }, 'list', iso);
  let r = await list(await token());
  if (!Array.isArray(r) && String(r?.error?.error_cd) === '238') r = await list(await token(true));   // token rejected: one fresh login, one retry
  if (Array.isArray(r)) return { rows: r, note: null };
  return { rows: [], note: r?.error?.message || JSON.stringify(r).slice(0, 160) };
}
