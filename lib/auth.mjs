// Accounts and sessions for the shared (multi-PC) app.
//
// Accounts live in data/users.json (scrypt-hashed passwords, never the password itself); they are made with
// `node scripts/user.mjs add <name>`. A login gives a random session token in an HttpOnly cookie; sessions are
// kept in data/sessions.json so a restart (a deploy, pm2's memory limit) does not sign everyone out.
//
// Open mode: with NO accounts and the app bound to this PC only (127.0.0.1) there is no login and the
// person is 'local' — how it has always run on one PC. Once an account exists, or the app listens on the
// network, a login is required for every page and every /api call (server.mjs refuses to start on the
// network without an account).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const USERS_FILE = join(DATA, 'users.json');
const SESSIONS_FILE = join(DATA, 'sessions.json');
export const COOKIE = 'hpz_session';
const SESSION_MS = 12 * 3600e3;          // sliding: each use pushes the end out again
const MAX_FAILS = 5, LOCK_MS = 60e3;     // 5 wrong passwords from one address for one name locks that pair for a minute

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1)); renameSync(`${file}.tmp`, file);
};

// --- accounts -------------------------------------------------------------------------------------
export const validName = (n) => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(String(n));   // lower case: a name is one person
const hash = (password, salt) => scryptSync(String(password), salt, 64);

export const loadUsers = () => readJson(USERS_FILE, { users: {} }).users || {};
export const hasUsers = () => Object.keys(loadUsers()).length > 0;

export function setPassword(name, password) {
  if (!validName(name)) throw new Error('name: 2-32 characters, lower case letters, digits, . _ -');
  if (String(password).length < 8) throw new Error('password must be at least 8 characters');
  const all = readJson(USERS_FILE, { users: {} }); all.users ||= {};
  const salt = randomBytes(16);
  all.users[name] = { salt: salt.toString('hex'), hash: hash(password, salt).toString('hex'), created: all.users[name]?.created || new Date().toISOString(), changed: new Date().toISOString() };
  writeJson(USERS_FILE, all);
  dropSessionsOf(name);   // a new password signs that person out everywhere
}
export function removeUser(name) {
  const all = readJson(USERS_FILE, { users: {} });
  if (!all.users?.[name]) return false;
  delete all.users[name]; writeJson(USERS_FILE, all); dropSessionsOf(name); return true;
}
export function checkPassword(name, password) {
  const u = loadUsers()[name];
  const salt = Buffer.from(u?.salt || '00'.repeat(16), 'hex');
  const got = hash(password, salt);   // run the hash even for an unknown name: same time either way
  return Boolean(u) && timingSafeEqual(got, Buffer.from(u.hash, 'hex'));
}

// --- sessions -------------------------------------------------------------------------------------
let sessions = readJson(SESSIONS_FILE, {});
const saveSessions = () => { try { writeJson(SESSIONS_FILE, sessions); } catch { /* best effort */ } };
const dropSessionsOf = (name) => { for (const [t, s] of Object.entries(sessions)) if (s.user === name) delete sessions[t]; saveSessions(); };

export function startSession(user) {
  const token = randomBytes(32).toString('hex');
  sessions[token] = { user, expires: Date.now() + SESSION_MS };
  for (const [t, s] of Object.entries(sessions)) if (s.expires < Date.now()) delete sessions[t];
  saveSessions();
  return token;
}
export const endSession = (token) => { if (sessions[token]) { delete sessions[token]; saveSessions(); } };

// The signed-in person for a token, or null. Using a session keeps it alive (written back at most once a minute).
let lastSlide = 0;
export function userOf(token) {
  const s = token && sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { endSession(token); return null; }
  if (loadUsers()[s.user] === undefined) { endSession(token); return null; }   // account removed
  s.expires = Date.now() + SESSION_MS;
  if (Date.now() - lastSlide > 60e3) { lastSlide = Date.now(); saveSessions(); }
  return s.user;
}

// The session token out of a Cookie header (64 hex characters, or nothing).
export function tokenFromCookie(header) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
  }
  return null;
}
export const sessionCookie = (token) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
export const clearedCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

// --- login throttling (in memory) -------------------------------------------------------------------
const fails = new Map();   // "ip|name" -> { n, until }
export function lockedFor(ip, name) {
  const f = fails.get(`${ip}|${name}`);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
export function noteFailure(ip, name) {
  const k = `${ip}|${name}`, f = fails.get(k) || { n: 0, until: 0 };
  f.n = f.until && f.until < Date.now() ? 1 : f.n + 1;
  if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(k, f);
}
export const noteSuccess = (ip, name) => fails.delete(`${ip}|${name}`);
