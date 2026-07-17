// F-002 dist-layout resolution gate.
//
// The `assertCanonical` guard in deploy.ts loads canonical-deployment.json via a
// static `import ... with { type: 'json' }`. The failure this gate exists to catch:
// if the JSON were loaded some other way (e.g. a readFileSync path copied from the
// test), it would resolve correctly from source but throw ENOENT from the shipped
// dist layout — a guard that rejects the LEGITIMATE canonical address. Source-only
// tests never exercise dist, so this runs the built module end-to-end.
//
// Run AFTER `bun run build`, from a cwd where @aztec/* peers resolve (the package's
// own node_modules). Exits non-zero (and prints the reason) if the built guard cannot
// load the canonical JSON, or rejects the canonical salt/address.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Fr } from '@aztec/aztec.js/fields';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const { registerPrivateContract } = await import(join(pkgRoot, 'dist/src/ts/utils/deploy.js'));
const canonical = JSON.parse(readFileSync(join(pkgRoot, 'canonical-deployment.json'), 'utf8'));

// Stub wallet: registerContract is what .register() ultimately calls; getInstance is
// computed by the deploy method itself. We only need the guard's JSON load + salt/address
// compares to run against the real dist module, so a minimal wallet that lets deploy()
// build a DeployMethod is sufficient — if the guard rejects the canonical inputs, the
// dist import of the JSON is broken (or the guard logic regressed), and we fail loudly.
const stubWallet = {
  registerContract: async () => ({}),
  // Aztec's DeployMethod may read chain/version off the wallet during getInstance();
  // provide permissive stubs so derivation reaches the address compare.
  getChainId: () => new Fr(1n),
  getVersion: () => new Fr(1n),
};

try {
  await registerPrivateContract(stubWallet, Fr.fromString(canonical.salt), { assertCanonical: true });
  console.log(
    `verify-dist-canonical: OK — built guard loaded canonical-deployment.json (${canonical.expectedAddress}) from the dist layout and accepted the canonical salt/address.`,
  );
} catch (err) {
  const msg = String(err && err.message ? err.message : err);
  // A resolution failure (ENOENT / ERR_MODULE_NOT_FOUND / cannot find module) is the
  // exact fable-BLOCKING bug this gate guards against — surface it unmistakably.
  if (/ENOENT|Cannot find module|ERR_MODULE_NOT_FOUND|no such file/i.test(msg)) {
    console.error(
      `verify-dist-canonical: FAIL — the built guard could not resolve canonical-deployment.json from dist: ${msg}`,
    );
    process.exit(1);
  }
  // If derivation reached the compares but rejected the CANONICAL inputs, the guard
  // is broken (it would throw on the legitimate address in production).
  if (/is not the canonical salt|does not match the canonical address/.test(msg)) {
    console.error(
      `verify-dist-canonical: FAIL — the built guard rejected the canonical salt/address (would reject the real deployment): ${msg}`,
    );
    process.exit(1);
  }
  // Any other error means the stub couldn't drive the real DeployMethod far enough to
  // reach the JSON load; that's an inconclusive gate — fail so it's fixed, not skipped.
  console.error(
    `verify-dist-canonical: INCONCLUSIVE — could not drive the built guard to the canonical checks (fix the stub or the gate): ${msg}`,
  );
  process.exit(1);
}
