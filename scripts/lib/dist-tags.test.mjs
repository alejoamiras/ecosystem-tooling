// node --test scripts/lib/dist-tags.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDistTags } from './dist-tags.mjs';

const doc = (tags) => JSON.stringify({ name: '@alejoamiras/x', 'dist-tags': tags });

test('reads one tag, and an absent tag is empty', () => {
  const body = doc({ latest: '5.0.1-revision.2', rc: '6.0.0-rc.1' });
  assert.equal(readDistTags(body, 'rc'), '6.0.0-rc.1');
  assert.equal(readDistTags(doc({ latest: '5.0.1' }), 'rc'), '');
  assert.deepEqual(JSON.parse(readDistTags(body)), { latest: '5.0.1-revision.2', rc: '6.0.0-rc.1' });
});

test('malformed registry data is an error, never an absent tag', () => {
  for (const bad of [
    doc({ latest: '5.0.1', rc: null }),
    doc({ latest: '5.0.1', rc: [] }),
    doc({ latest: '5.0.1', rc: '' }),
    doc({ latest: 5 }),
    JSON.stringify({ name: 'x' }),
    JSON.stringify({ 'dist-tags': [] }),
    'not json',
  ]) {
    assert.throws(() => readDistTags(bad, 'rc'), undefined, bad);
  }
});
