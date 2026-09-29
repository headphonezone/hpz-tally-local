// Loads .env from the app folder before any other module reads process.env.
//
// server.mjs imports this FIRST. ES modules evaluate in import order, so lib/tally.mjs — which
// reads HPZ_TALLY_URL when it loads — already sees these values. Loading here rather than with
// `node --env-file` means it behaves identically under PM2, run.cmd, or a bare `node server.mjs`.
//
// Variables already present in the environment (e.g. set by ecosystem.config.cjs) win over the
// file, so PM2's env block remains the override it has always been.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (existsSync(file)) {
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
