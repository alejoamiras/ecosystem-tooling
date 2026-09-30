import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import known from '../../../../known-deployments.json' with { type: 'json' };
import { reconstructUpstream, type SanctionedEdit } from '../../../../scripts/lineage-core.js';
import { anchorForClassId, selectAnchor } from '../../operator/lineage.js';

const vendored = readFileSync(new URL('../../../nr/quota_fpc/src/main.nr', import.meta.url), 'utf8');
const edits = known.provenance.sanctionedEdits as SanctionedEdit[];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('reconstructUpstream', () => {
  test('the vendored main.nr minus its enumerated deviations IS the recorded upstream', () => {
    expect(sha256(reconstructUpstream(vendored, edits))).toBe(
      known.provenance.upstreamSha256['contracts/fpc/quota_fpc/src/main.nr'],
    );
  });

  test('an unlisted edit survives reconstruction, so the hash comparison fails', () => {
    const tampered = vendored.replace(
      'global UPDATE_DELAY_SECONDS: u64 = 43200;',
      'global UPDATE_DELAY_SECONDS: u64 = 60;',
    );
    expect(tampered).not.toBe(vendored);
    expect(sha256(reconstructUpstream(tampered, edits))).not.toBe(
      known.provenance.upstreamSha256['contracts/fpc/quota_fpc/src/main.nr'],
    );
  });

  test('a sanctioned block that is missing or duplicated is an error, not a skip', () => {
    const [first] = edits as [SanctionedEdit];
    const missing = vendored.replace(first.vendored.join('\n'), first.upstream.join('\n'));
    expect(() => reconstructUpstream(missing, edits)).toThrow(/found 0 times/);
    const duplicated = `${vendored}\n${first.vendored.join('\n')}`;
    expect(() => reconstructUpstream(duplicated, edits)).toThrow(/found 2 times/);
  });
});

describe('lineage anchors', () => {
  test('5.0.1 is the chain-verified anchor; a version never reviewed has none', () => {
    expect(selectAnchor(known, '5.0.1')).toMatchObject({ classId: known.mainnet.classId, chainVerified: true });
    expect(() => selectAnchor(known, '9.9.9')).toThrow(/no lineage anchor for Aztec 9\.9\.9/);
  });

  test('an unreviewed class id matches no anchor, so the deploy guard refuses it', () => {
    expect(anchorForClassId(known, `0x${'0'.repeat(64)}`)).toBeUndefined();
  });
});
