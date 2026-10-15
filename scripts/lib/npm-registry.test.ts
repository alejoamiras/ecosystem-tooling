import { expect, test } from 'bun:test';

import { PUBLIC_REGISTRY, viewArgs } from './npm-registry.ts';

test('npm view is pinned to the public registry past scoped and default-scope registries', () => {
  expect(viewArgs('@aztec/viem@2.38.3')).toEqual([
    'view',
    '@aztec/viem@2.38.3',
    '--json',
    `--registry=${PUBLIC_REGISTRY}`,
    '--scope=',
    `--@aztec:registry=${PUBLIC_REGISTRY}`,
  ]);
  expect(viewArgs('left-pad@1.3.0')).toEqual([
    'view',
    'left-pad@1.3.0',
    '--json',
    `--registry=${PUBLIC_REGISTRY}`,
    '--scope=',
  ]);
});
