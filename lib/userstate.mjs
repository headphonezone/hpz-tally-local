// Per-person working state. Each signed-in person has their own fetched lists, running jobs and "stop" flags,
// so two people on different screens (or different date ranges of the same screen) never replace each other's
// work. The request handler runs everything for a person inside runAs(); code anywhere below it just reads and
// writes S.<name>, which resolves to the calling person's slot. Work started outside a request (the scheduled
// BlueDart check) runs as 'system'.
//
// What stays shared on purpose is the Tally busy flags in server.mjs: the Tally gateway takes one job at a
// time no matter who asked for it.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const slots = new Map();   // user -> state

export const SYSTEM = 'system';
const blank = () => ({
  report: null, job: null,                                   // Material Out
  gstJob: { ewb: null, einv: null }, gstReport: { ewb: null, einv: null },
  miJob: null, miReport: null,                               // Missing Invoice
  codJob: null, codReport: null,                             // COD Import
  cnReport: null, cnMasters: null, cnJob: null, cnStopAsked: false,   // Credit Note
  ucReport: null, ucMasters: null, ucJob: null, ucStopAsked: false,   // Unicommerce Sales
  piMasters: null,                                           // Purchase Import
});

export const runAs = (user, fn) => als.run(user || SYSTEM, fn);
export const currentUser = () => als.getStore() || SYSTEM;
const lastUsed = new Map();   // user -> ms of the last time their state was read or written
const slotOf = (user) => { let s = slots.get(user); if (!s) slots.set(user, s = blank()); lastUsed.set(user, Date.now()); return s; };

export const S = new Proxy({}, {
  get: (_, key) => slotOf(currentUser())[key],
  set: (_, key, value) => { slotOf(currentUser())[key] = value; return true; },
});

// Free the fetched lists of people who have been idle for `idleMs` and have nothing running: a month of Sales
// orders is ~400 MB in memory, and five people each holding one add up. The next time they open the screen it
// simply shows no list and they press Fetch again.
export function pruneIdle(idleMs, running) {
  const freed = [];
  for (const [user, s] of slots) {
    if (user === SYSTEM || running(s) || Date.now() - (lastUsed.get(user) || 0) < idleMs) continue;
    slots.delete(user); lastUsed.delete(user); freed.push(user);
  }
  return freed;
}

// Is any person's state matching `pick`? (the Tally-busy rule looks across everyone)
export const anyUser = (pick) => [...slots.values()].some(pick);
// Who is running a Tally job right now, if anyone (for "in use by <name>" messages).
export const jobOwner = (pick) => { for (const [user, s] of slots) if (pick(s)) return user; return null; };
