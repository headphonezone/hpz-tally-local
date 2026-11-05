import assert from 'node:assert/strict';
import { buildStockItem } from '../lib/purchase.mjs';

// Without an alias the item is exactly as before.
const plain = buildStockItem({ name: 'Foo - Black', group: 'Headphones', category: 'Foo' });
assert.equal(plain['languagename.list'], undefined);
assert.equal(plain.parent, 'Headphones');
assert.equal(plain.category, 'Foo');

// A blank alias is no alias.
assert.equal(buildStockItem({ name: 'Foo - Black', group: 'G', category: 'C', alias: '   ' })['languagename.list'], undefined);

// With an alias: Tally's name list, the item's own name first, the alias after.
const withAlias = buildStockItem({ name: 'Foo - Black', group: 'G', category: 'C', alias: ' FOO-BLK ' });
assert.deepEqual(withAlias['languagename.list'], [{ 'name.list': { name: ['Foo - Black', 'FOO-BLK'] }, languageid: 1033 }]);
assert.equal(withAlias.name, 'Foo - Black');

console.log('purchase-item-alias: ok');
