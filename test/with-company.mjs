// withCompany names the company in a read; outside it nothing is named.   node test/with-company.mjs
import assert from 'node:assert/strict';
const bodies = [];
globalThis.fetch = async (_u, o) => { bodies.push(String(o.body)); return new Response('<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>', { status: 200 }); };
const { withCompany, stockGroupsAndCategories, purchaseVouchersInRange } = await import('../lib/tally.mjs');
await purchaseVouchersInRange('20260401', '20260430');
assert.ok(!bodies.at(-1).includes('SVCURRENTCOMPANY'), 'no company named by default');
await withCompany('Ferrari Video & Co - (from 1-Apr-26)', () => purchaseVouchersInRange('20260401', '20260430'));
assert.ok(bodies.at(-1).includes('<SVCURRENTCOMPANY>Ferrari Video &amp; Co - (from 1-Apr-26)</SVCURRENTCOMPANY>'), 'named inside');
await Promise.all([withCompany('A', () => purchaseVouchersInRange('20260401', '20260430')), purchaseVouchersInRange('20260401', '20260430')]);
assert.ok(bodies.slice(-2).some((b) => b.includes('<SVCURRENTCOMPANY>A<')) && bodies.slice(-2).some((b) => !b.includes('SVCURRENTCOMPANY')), 'one call named, one not');
await purchaseVouchersInRange('20260401', '20260430');
assert.ok(!bodies.at(-1).includes('SVCURRENTCOMPANY'), 'not left set afterwards');
console.log('with-company: ok');
