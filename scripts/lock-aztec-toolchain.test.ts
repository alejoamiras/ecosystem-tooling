import { describe, expect, test } from 'bun:test';

import { parseVersions, selectAsset } from './lock-aztec-toolchain.ts';

describe('parseVersions', () => {
  test('reads the upstream manifest', () => {
    expect(parseVersions('noir: 1.0.0-rc.3\nfoundry: 1.4.1\nnode: 24.12.0\n')).toEqual({
      noir: '1.0.0-rc.3',
      foundry: '1.4.1',
      node: '24.12.0',
    });
  });

  test('rejects any shape it would have to guess at', () => {
    for (const [text, err] of [
      ['noir: 1.0.0\nfoundry: 1.4.1\n', /no node entry/],
      ['noir: 1.0.0\nnoir: 1.0.1\nfoundry: 1.4.1\nnode: 24\n', /duplicate noir/],
      ['noir 1.0.0\nfoundry: 1.4.1\nnode: 24\n', /malformed line/],
      ['noir: 1.0.0/../x\nfoundry: 1.4.1\nnode: 24\n', /invalid noir version/],
    ] as const) {
      expect(() => parseVersions(text)).toThrow(err);
    }
  });
});

describe('selectAsset', () => {
  const repo = 'foundry-rs/foundry';
  const tag = 'v1.4.1';
  const name = 'foundry_v1.4.1_linux_amd64.tar.gz';
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
  const hex = 'f1b044ee954402807c4dd5a5e7d29b210d24fd3633b7f199d184f034ff94d934';
  const good = { name, digest: `sha256:${hex}`, browser_download_url: url };

  test('pins the named asset at its canonical URL', () => {
    const other = { name: `${name}.sig`, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: `${url}.sig` };
    expect(selectAsset([other, good], repo, tag, name)).toEqual({ url, sha256: hex });
  });

  test('rejects a missing or duplicated asset, a foreign URL, and a malformed digest', () => {
    expect(() => selectAsset([], repo, tag, name)).toThrow(/found 0/);
    expect(() => selectAsset([good, good], repo, tag, name)).toThrow(/found 2/);
    expect(() => selectAsset([{ ...good, browser_download_url: 'https://evil.example/x' }], repo, tag, name)).toThrow(
      /is not/,
    );
    for (const digest of [undefined, hex, `sha512:${hex}`, `sha256:${hex.toUpperCase()}`]) {
      expect(() => selectAsset([{ ...good, digest }], repo, tag, name)).toThrow(/no sha256 digest/);
    }
  });
});
