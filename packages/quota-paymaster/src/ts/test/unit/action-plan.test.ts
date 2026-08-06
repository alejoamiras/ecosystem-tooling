/** The mutation protocol: confirm THIS exact plan, revalidate before send. */
import { describe, expect, test } from 'vitest';
import {
  ActionAborted,
  ActionRevalidationFailed,
  confirmAndRevalidate,
  createActionPlan,
  digestOptions,
  snapshotOptions,
} from '../../operator/action-plan.js';

describe('action plans', () => {
  test('digest is stable under key order and changes with any value', () => {
    const a = createActionPlan('bridge-fee-juice', { to: '0x1', amountWei: '5' });
    const b = createActionPlan('bridge-fee-juice', { amountWei: '5', to: '0x1' });
    const c = createActionPlan('bridge-fee-juice', { to: '0x1', amountWei: '6' });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
  });

  test('plans are frozen — what was confirmed cannot be mutated afterwards', () => {
    const plan = createActionPlan('deploy-quota-fpc', { admin: '0x1' });
    expect(() => {
      (plan.details as Record<string, unknown>).admin = '0xevil';
    }).toThrow();
  });

  test('anything but an explicit true from confirm aborts', async () => {
    const plan = createActionPlan('claim-fee-juice', { recipient: '0x1' });
    await expect(
      confirmAndRevalidate(
        plan,
        async () => false,
        async () => undefined,
      ),
    ).rejects.toThrow(ActionAborted);
    await expect(
      // A truthy non-true (a Promise-shaped mistake, a 1) must NOT pass.
      confirmAndRevalidate(plan, (() => 1) as never, async () => undefined),
    ).rejects.toThrow(ActionAborted);
  });

  test('a chain that moved between confirm and send aborts with nothing sent', async () => {
    const plan = createActionPlan('schedule-policy-change', { expectedRevision: '3' });
    await expect(
      confirmAndRevalidate(
        plan,
        async () => true,
        async () => 'revision moved 3 -> 4',
      ),
    ).rejects.toThrow(ActionRevalidationFailed);
  });

  test('the happy path resolves silently', async () => {
    const plan = createActionPlan('bridge-fee-juice', { to: '0x1' });
    await expect(
      confirmAndRevalidate(
        plan,
        async () => true,
        async () => undefined,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('option snapshots and digests', () => {
  test('snapshotOptions deep-copies plain nesting; mutation after snapshot has no effect', () => {
    class FakePayment {
      kind = 'fake';
    }
    const original = { fee: { gasSettings: { l2GasLimit: 100 } }, method: new FakePayment() };
    const snap = snapshotOptions(original);
    original.fee.gasSettings.l2GasLimit = 999;
    expect((snap.fee as { gasSettings: { l2GasLimit: number } }).gasSettings.l2GasLimit).toBe(100);
    // Class instances stay by reference — the documented residual.
    expect(snap.method).toBe(original.method);
  });

  test('digestOptions is type-injective and sensitive to instance class swaps', () => {
    // Round-5 observation: without type tags, 1n vs "1n" and undefined vs
    // null collide.
    expect(digestOptions({ a: 1n })).not.toBe(digestOptions({ a: '1n' }));
    expect(digestOptions({ a: undefined })).not.toBe(digestOptions({ a: null }));
    expect(digestOptions({ a: 1 })).not.toBe(digestOptions({ a: '1' }));
    class MethodA {}
    class MethodB {}
    expect(digestOptions({ m: new MethodA() })).not.toBe(digestOptions({ m: new MethodB() }));
    // Deterministic across key order.
    expect(digestOptions({ a: 1, b: 2 })).toBe(digestOptions({ b: 2, a: 1 }));
  });
});
