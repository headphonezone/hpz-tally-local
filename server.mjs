import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ping, activeCompany, loadedCompanies } from './lib/tally.mjs';
import { buildReport } from './lib/report.mjs';
import { createMaterialOut } from './lib/create.mjs';
import { reportToXlsx } from './lib/excel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7654);

let report = null;
let job = null; // { type, running, done, total, message, error }
let lastSeen = { tallyUp: false, openCompany: null, companies: [] };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

async function startBuild(book, from, to) {
  job = { type: 'build', running: true, done: 0, total: 0, message: 'Reading sheet and Tally…', error: '' };
  try {
    report = await buildReport({ book, from, to });
    job = { type: 'build', running: false, message: `Built in ${(report.tookMs / 1000).toFixed(1)}s`, error: '' };
  } catch (err) {
    job = { type: 'build', running: false, message: '', error: err.message };
  }
}

async function startCreate(wcids) {
  if (!report) throw new Error('build the report first');
  const wanted = new Set(wcids);
  const rows = report.rows.filter((r) => wanted.has(r.wcid));
  job = { type: 'create', running: true, done: 0, total: rows.length, message: 'Creating vouchers…', error: '' };
  try {
    const result = await createMaterialOut(rows, {
      report,
      onProgress: ({ done, total }) => { job.done = done; job.total = total; },
    });
    // Reflect the new vouchers so a created row cannot be submitted twice.
    const created = new Set(result.results.filter((r) => r.created).map((r) => r.wcid));
    for (const row of report.rows) {
      if (created.has(row.wcid)) { row.status = 'done'; row.reason = ''; }
    }
    report.counts = { ready: 0, done: 0, blocked: 0 };
    for (const r of report.rows) report.counts[r.status]++;
    job = { type: 'create', running: false, message: `Created ${result.created}, failed ${result.failed}`, error: '', result };
  } catch (err) {
    job = { type: 'create', running: false, message: '', error: err.message };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/api/state') {
      // The open company is re-read on every poll, never taken from the cached
      // report: closing a company in Tally must not leave a stale name on screen
      // next to a Create button.
      // While a job runs, this endpoint touches Tally not at all and answers
      // from the last known values. Polling the gateway during a build is
      // exactly the overlap that wedges it.
      let tallyUp = lastSeen.tallyUp, openCompany = lastSeen.openCompany, companies = lastSeen.companies;
      if (!job?.running) {
        tallyUp = await ping();
        openCompany = null; companies = [];
        if (tallyUp) {
          try {
            openCompany = await activeCompany();
            companies = await loadedCompanies();
          } catch { /* report it as unknown rather than failing the poll */ }
        }
        lastSeen = { tallyUp, openCompany, companies };
      }
      return json(res, 200, {
        tallyUp,
        openCompany,
        companies,
        job,
        report: report && {
          builtAt: report.builtAt, company: report.company, book: report.book, range: report.range,
          counts: report.counts, totals: report.totals,
        },
      });
    }

    if (url.pathname === '/api/build' && req.method === 'POST') {
      if (job?.running) return json(res, 409, { error: 'a job is already running' });
      const { book = 'live', from, to } = await readBody(req);
      if (!from || !to) return json(res, 400, { error: 'pick a from and to date' });
      startBuild(book, from, to);
      return json(res, 202, { started: true });
    }

    if (url.pathname === '/api/rows') {
      if (!report) return json(res, 200, { rows: [], total: 0 });
      const status = url.searchParams.get('status') || '';
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 2000);
      const offset = Number(url.searchParams.get('offset') || 0);
      let rows = report.rows;
      if (status) rows = rows.filter((r) => r.status === status);
      if (q) {
        rows = rows.filter((r) => [r.wcid, r.customer, r.sheetEmail, r.mi?.stockItem, r.mi?.party]
          .some((v) => v && String(v).toLowerCase().includes(q)));
      }
      return json(res, 200, { total: rows.length, rows: rows.slice(offset, offset + limit) });
    }

    if (url.pathname === '/api/create' && req.method === 'POST') {
      if (job?.running) return json(res, 409, { error: 'a job is already running' });
      const { wcids } = await readBody(req);
      if (!Array.isArray(wcids) || !wcids.length) return json(res, 400, { error: 'no rows selected' });
      startCreate(wcids);
      return json(res, 202, { started: true, count: wcids.length });
    }

    if (url.pathname === '/api/excel') {
      if (!report) return json(res, 409, { error: 'build the report first' });
      const buffer = await reportToXlsx(report);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="material-out-${report.book}-${stamp}.xlsx"`,
      });
      return res.end(Buffer.from(buffer));
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HPZ Material Out app  ->  http://localhost:${PORT}`);
  console.log('Reads and writes whichever company is open in Tally.');
});
