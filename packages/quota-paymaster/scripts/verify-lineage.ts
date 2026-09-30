// verify:lineage — binds SOURCE → artifact → the reviewed class id for this Aztec version.
// Runs in EVERY phase gate. Pure local hash/artifact checks, milliseconds, no network.
//
// Asserts:
//  (a) SHA-256 of the four pinned vendored files matches provenance.vendoredSha256, AND
//      reversing the enumerated deviations (sanctioned edit blocks, the `pub mod test;`
//      line, two `pub` markers) reproduces the recorded UPSTREAM hash, so nothing else
//      changed;
//  (b) the repo lock file pins the aztec-nr dependency quota_fpc's Nargo.toml names;
//  (c) the compiled target artifact AND the codegen'd consumer artifact both have the class
//      id anchored for the root config.aztecVersion. Only the 5.0.1 anchor was ever checked
//      against a chain; later anchors are local pins, and the output says which.
// An edit to a PINNED file without recompile fails (a); a stale artifact fails (c).
// Deliberately unpinned: the TXE test modules (src/test/*.nr). They do not compile
// into the release artifact — the class-id checks in (c) prove that — and pinning
// them would turn every legitimate test change into a provenance ceremony. Their
// integrity is guarded by review plus the CI TXE count floor, not by lineage
// (post-impl audit finding #9: this scope is a choice, not an oversight).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type KnownDeployments, selectAnchor } from '../src/ts/operator/lineage.js';
import { classIdOfArtifact, classIdOfArtifactJson } from './artifact-class-id.js';
import { reconstructUpstream, type SanctionedEdit } from './lineage-core.js';

const pkgRoot = new URL('..', import.meta.url);
const repoRoot = new URL('../../..', import.meta.url);
const read = (base: URL, rel: string) => readFileSync(new URL(rel, base), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const known: KnownDeployments & {
  provenance: {
    vendoredSha256: Record<string, string>;
    upstreamSha256: Record<string, string>;
    sanctionedEdits?: SanctionedEdit[];
  };
} = JSON.parse(read(pkgRoot, 'known-deployments.json'));
const { provenance } = known;
const aztecVersion: string = JSON.parse(read(repoRoot, 'package.json')).config.aztecVersion;
const anchor = selectAnchor(known, aztecVersion);
const anchorKind = anchor.chainVerified ? 'chain-verified' : 'locally pinned';
const failures: string[] = [];

// (a) vendored source freshness + upstream reconstruction
for (const [rel, expected] of Object.entries(provenance.vendoredSha256)) {
  const actual = sha256(read(pkgRoot, rel));
  if (actual !== expected) failures.push(`vendored hash mismatch: ${rel} (${actual} != recorded ${expected})`);
}
try {
  const reverted = reconstructUpstream(read(pkgRoot, 'src/nr/quota_fpc/src/main.nr'), provenance.sanctionedEdits ?? []);
  if (sha256(reverted) !== provenance.upstreamSha256['contracts/fpc/quota_fpc/src/main.nr']) {
    failures.push('main.nr deviates from upstream beyond the enumerated sanctioned deviations');
  }
} catch (e) {
  failures.push(`main.nr: ${(e as Error).message}`);
}
if (
  sha256(read(pkgRoot, 'src/nr/fpc_test_target/src/main.nr')) !==
  provenance.upstreamSha256['contracts/fpc/fpc_test_target/src/main.nr']
) {
  failures.push('fpc_test_target main.nr deviates from upstream');
}

// (b) locked dependency commit present, keyed exactly as scripts/verify-nargo-refs.sh keys it
{
  const lock = JSON.parse(read(repoRoot, 'nargo-deps.lock.json'));
  const aztecDep = read(pkgRoot, 'src/nr/quota_fpc/Nargo.toml')
    .split('\n')
    .find((line) => /^\s*aztec\s*=/.test(line));
  const url = aztecDep && /\bgit\s*=\s*"([^"]+)"/.exec(aztecDep)?.[1]?.replace(/\/+$/, '');
  const tag = aztecDep && /\btag\s*=\s*"([^"]+)"/.exec(aztecDep)?.[1];
  if (!url || !tag) failures.push('quota_fpc Nargo.toml: no aztec dependency with a url and tag');
  else if (!lock[`${url}@${tag}`]) failures.push(`nargo-deps.lock.json has no entry for ${url}@${tag}`);
}

// (c) both artifacts carry the anchored class id
const expectedClassId = anchor.classId;
const targetPath = new URL('target/quota_fpc-QuotaFpc.json', pkgRoot);
if (!existsSync(targetPath)) {
  failures.push('target/quota_fpc-QuotaFpc.json missing — run compile before verify:lineage');
} else {
  const id = await classIdOfArtifactJson(targetPath);
  if (id !== expectedClassId) failures.push(`target artifact class id ${id} != ${anchorKind} ${expectedClassId}`);
}
const consumerPath = new URL('src/artifacts/QuotaFpc.ts', pkgRoot);
if (!existsSync(consumerPath)) {
  failures.push('src/artifacts/QuotaFpc.ts missing — run codegen before verify:lineage');
} else {
  const mod = await import(consumerPath.pathname);
  const artifact = mod.QuotaFpcContractArtifact;
  if (!artifact) {
    failures.push('src/artifacts/QuotaFpc.ts does not export QuotaFpcContractArtifact');
  } else {
    const id = await classIdOfArtifact(artifact);
    if (id !== expectedClassId) failures.push(`consumer artifact class id ${id} != ${anchorKind} ${expectedClassId}`);
  }
}

if (failures.length > 0) {
  console.error('verify:lineage FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  anchor.chainVerified
    ? `verify:lineage OK — class id ${expectedClassId} (Aztec ${aztecVersion}, chain-verified)`
    : `verify:lineage OK — class id ${expectedClassId} (Aztec ${aztecVersion}) matches the locally pinned ` +
        'compiled entry. NOT chain-verified: this proves source/artifact consistency with a reviewed pin, not a deployment.',
);
