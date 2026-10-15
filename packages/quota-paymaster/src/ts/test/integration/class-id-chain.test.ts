/**
 * The pinned class id, read back from a node: a QuotaFpc deployed from the
 * shipped artifact must report the anchored class as both its current and its
 * original class. This is the evidence behind `localNodeVerification` in
 * known-deployments.json — a disposable local node, never a public chain.
 */
import { getContractClassFromArtifact } from '@aztec-labs/aztec.js/contracts';
import { beforeAll, describe, expect, test } from 'vitest';
import known from '../../../../known-deployments.json' with { type: 'json' };
import { FpcTestTargetContract } from '../../../artifacts/FpcTestTarget.js';
import { QuotaFpcContractArtifact } from '../../../artifacts/QuotaFpc.js';
import { type KnownDeployments, selectAnchor } from '../../operator/lineage.js';
import { type Ctx, connect, evidence } from '../harness.js';
import { deployOwnFpc } from '../suite-helpers.js';

describe('QuotaFpc class id on a local node', () => {
  let ctx: Ctx;
  let address: import('@aztec-labs/stdlib/aztec-address').AztecAddress;

  beforeAll(async () => {
    ctx = await connect();
    const admin = ctx.addresses[0];
    const targetDeploy = FpcTestTargetContract.deploy(ctx.wallet);
    await targetDeploy.send({ from: admin });
    const target = await targetDeploy.register();
    address = (await deployOwnFpc(ctx, target, admin)).address;
  });

  test('the node derives the anchored class id as both current and original', async () => {
    const anchor = selectAnchor(known as KnownDeployments, known.currentAztecVersion);
    const artifactClassId = (await getContractClassFromArtifact(QuotaFpcContractArtifact)).id.toString();
    const instance = await ctx.node.getContract(address);
    if (!instance) throw new Error(`node returned no contract at ${address}`);
    const current = instance.currentContractClassId.toString();
    const original = instance.originalContractClassId.toString();
    evidence('class-id', { address: address.toString(), anchor: anchor.classId, current, original });

    expect(artifactClassId).toBe(anchor.classId);
    expect(current).toBe(anchor.classId);
    expect(original).toBe(anchor.classId);
  });
});
