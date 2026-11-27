import assert from 'node:assert/strict';
import { buildStockItem } from '../lib/purchase.mjs';
import { addStockItemAliases } from '../lib/tally.mjs';

// The create JSON carries no alias list: Tally's JSON import drops it silently (2026-11-27), the alias goes in as XML afterwards.
const item = buildStockItem({ name: 'Foo - Black', group: 'Headphones', category: 'Foo', alias: 'FOO-BLK' });
assert.equal(item['languagename.list'], undefined);
assert.equal(item.parent, 'Headphones'); assert.equal(item.category, 'Foo'); assert.equal(item.name, 'Foo - Black');

// A fake Tally: the plain item-list read, and an XML master import that sets an item's NAME.LIST.
const names = new Map([['Foo - Black', ['Foo - Black']], ['Bar & Baz - Red', ['Bar & Baz - Red', 'BAR-OLD']], ['No Alias', ['No Alias']]]);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
let imports = 0, dropAliases = false;
globalThis.fetch = async (_url, { body }) => {
  const req = Buffer.from(body).toString('latin1');
  let out;
  if (req.includes('<TALLYREQUEST>Import</TALLYREQUEST>')) {
    imports++;
    for (const m of req.matchAll(/<STOCKITEM NAME="([^"]*)" ACTION="Alter">([\s\S]*?)<\/STOCKITEM>/g)) {
      const name = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const list = [...m[2].matchAll(/<NAME>([^<]*)<\/NAME>/g)].map((x) => x[1].replace(/&amp;/g, '&'));
      names.set(name, dropAliases ? [name] : list);
    }
    out = '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT><CREATED>0</CREATED><ALTERED>2</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></IMPORTRESULT></DATA></BODY></ENVELOPE>';
  } else {
    out = '<ENVELOPE><BODY><DATA><COLLECTION>' + [...names].map(([n, l]) => `<STOCKITEM NAME="${esc(n)}" RESERVEDNAME=""><LANGUAGENAME.LIST><NAME.LIST TYPE="String">${l.map((x) => `<NAME>${esc(x).replace(/&quot;/g, '"')}</NAME>`).join('')}</NAME.LIST></LANGUAGENAME.LIST></STOCKITEM>`).join('') + '</COLLECTION></DATA></BODY></ENVELOPE>';
  }
  return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(out).buffer };
};

// Nothing to add: no call at all.
assert.deepEqual(await addStockItemAliases([{ name: 'Foo - Black', alias: '  ' }]), { items: [], stored: 0, missing: [], import: null });
assert.equal(imports, 0);

// Two items: the alias is added, an alias the item already had is kept, and each is read back.
const r = await addStockItemAliases([{ name: 'Foo - Black', alias: 'FOO-BLK' }, { name: 'Bar & Baz - Red', alias: 'BAR-NEW' }]);
assert.equal(imports, 1, 'one import for both');
assert.deepEqual(names.get('Foo - Black'), ['Foo - Black', 'FOO-BLK']);
assert.deepEqual(names.get('Bar & Baz - Red'), ['Bar & Baz - Red', 'BAR-OLD', 'BAR-NEW']);
assert.deepEqual(names.get('No Alias'), ['No Alias'], 'other items untouched');
assert.equal(r.stored, 2); assert.deepEqual(r.missing, []);
assert.deepEqual(r.import, { altered: 2, errors: 0, exceptions: 0 });

// Tally accepts the import but does not keep the alias: reported as missing, not as success.
dropAliases = true;
const r2 = await addStockItemAliases([{ name: 'No Alias', alias: 'NOPE' }]);
assert.equal(r2.stored, 0); assert.deepEqual(r2.missing, [{ name: 'No Alias', alias: 'NOPE', stored: false }]);

console.log('purchase-item-alias: ok');
