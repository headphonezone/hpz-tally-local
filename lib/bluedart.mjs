// BlueDart manifest (BigQuery project bluedart-webhook, dataset Manifest), read only.
//
// The GSP list has no courier, so a portal e-Way Bill is matched to its AWB through Tally, and the
// AWB to a dispatch here. Same query as bluedart_dispatch_sync.py, so the two cannot disagree.
//
// Auth: a service-account JSON key file named by BLUEDART_SA_KEY, signed here with node:crypto —
// no Google SDK needed.

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';

const PROJECT = 'bluedart-webhook';
const DATASET = 'Manifest';

export const configured = () => Boolean(process.env.BLUEDART_SA_KEY && existsSync(process.env.BLUEDART_SA_KEY));
export const couriers = () => String(process.env.DISPATCH_COURIERS || 'BLUEDART')
  .split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);

let cached = { token: null, exp: 0 };

async function accessToken() {
  if (cached.token && cached.exp > Date.now() + 60000) return cached.token;
  const sa = JSON.parse(readFileSync(process.env.BLUEDART_SA_KEY, 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('BigQuery login failed: ' + JSON.stringify(d).slice(0, 200));
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cached.token;
}

// AWB -> { courier, dispatchedAt (Date|null) } for every AWB found in the manifest.
export async function manifestFor(awbs) {
  const list = [...new Set(awbs.filter(Boolean).map(String))];
  if (!list.length) return new Map();
  if (!configured()) throw new Error('BlueDart manifest not configured — set BLUEDART_SA_KEY in .env to the service-account key file');
  const lit = list.map((a) => `'${a.replace(/[^A-Za-z0-9_-]/g, '')}'`).join(',');
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      useLegacySql: false, timeoutMs: 180000,
      query: `select p.tracking_number awb, upper(trim(p.courier)) courier, max(d.dispatched_at) dispatched_at
              from \`${PROJECT}.${DATASET}.manifest_packages\` p
              left join \`${PROJECT}.${DATASET}.manifest_dispatch_log\` d on d.tracking_number = p.tracking_number
              where p.tracking_number in (${lit}) group by 1, 2`,
    }),
    signal: AbortSignal.timeout(240000),
  });
  const d = await res.json();
  if (!res.ok || d.error) throw new Error('BigQuery error: ' + JSON.stringify(d.error || d).slice(0, 300));
  if (d.jobComplete === false) throw new Error('BigQuery query did not finish in time — try again');
  const cols = (d.schema?.fields || []).map((f) => f.name);
  const out = new Map();
  for (const r of d.rows || []) {
    const row = Object.fromEntries(cols.map((c, i) => [c, r.f[i].v]));
    // BigQuery returns a TIMESTAMP as epoch seconds in a string.
    out.set(row.awb, { courier: row.courier, dispatchedAt: row.dispatched_at ? new Date(Number(row.dispatched_at) * 1000) : null });
  }
  return out;
}
