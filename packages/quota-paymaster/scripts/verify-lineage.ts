// verify:lineage — binds SOURCE → artifact → chain-verified class id (plan D2.3).
// Runs in EVERY phase gate. Pure local hash/artifact checks, milliseconds, no network.
//
// Asserts:
//  (a) SHA-256 of the four pinned vendored files matches provenance.vendoredSha256, AND the
//      vendored main.nr minus exactly one `pub mod test;` line reproduces the recorded
//      UPSTREAM hash (so the registration line is provably the only source deviation);
//  (b) the repo lock file pins the aztec-packages@v5.0.1 dependency this package compiles
//      against;
//  (c) the compiled target artifact AND the codegen'd consumer artifact both have the
//      chain-verified class id from known-deployments.json.
// A source edit without recompile fails (a); a stale artifact fails (c).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/stdlib/abi';

const pkgRoot = new URL('..', import.meta.url);
const repoRoot = new URL('../../..', import.meta.url);
const read = (base: URL, rel: string) => readFileSync(new URL(rel, base), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const known = JSON.parse(read(pkgRoot, 'known-deployments.json'));
const { provenance, mainnet } = known;
const failures: string[] = [];

// (a) vendored source freshness + upstream reconstruction
for (const [rel, expected] of Object.entries<string>(provenance.vendoredSha256)) {
  const actual = sha256(read(pkgRoot, rel));
  if (actual !== expected) failures.push(`vendored hash mismatch: ${rel} (${actual} != recorded ${expected})`);
}
{
  const vendored = read(pkgRoot, 'src/nr/quota_fpc/src/main.nr');
  const lines = vendored.split('\n');
  const modIdx = lines.indexOf('pub mod test;');
  if (modIdx === -1) {
    failures.push('main.nr: the sanctioned `pub mod test;` registration line is missing');
  } else {
    const reconstructed = [...lines.slice(0, modIdx), ...lines.slice(modIdx + 1)].join('\n');
    const upstream = provenance.upstreamSha256['contracts/fpc/quota_fpc/src/main.nr'];
    if (sha256(reconstructed) !== upstream) {
      failures.push('main.nr deviates from upstream by MORE than the single registration line');
    }
  }
  const targetUpstream = provenance.upstreamSha256['contracts/fpc/fpc_test_target/src/main.nr'];
  if (sha256(read(pkgRoot, 'src/nr/fpc_test_target/src/main.nr')) !== targetUpstream) {
    failures.push('fpc_test_target main.nr deviates from upstream');
  }
}

// (b) locked dependency commit present
{
  const lock = JSON.parse(read(repoRoot, 'nargo-deps.lock.json'));
  const key = 'https://github.com/AztecProtocol/aztec-packages@v5.0.1';
  if (!lock[key]) failures.push(`nargo-deps.lock.json has no entry for ${key}`);
}

// (c) both artifacts carry the chain-verified class id
const expectedClassId: string = mainnet.classId;
const targetPath = new URL('target/quota_fpc-QuotaFpc.json', pkgRoot);
if (!existsSync(targetPath)) {
  failures.push('target/quota_fpc-QuotaFpc.json missing — run compile before verify:lineage');
} else {
  const artifact = loadContractArtifact(JSON.parse(readFileSync(targetPath, 'utf8')));
  const id = (await getContractClassFromArtifact(artifact)).id.toString();
  if (id !== expectedClassId) failures.push(`target artifact class id ${id} != chain-verified ${expectedClassId}`);
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
    const id = (await getContractClassFromArtifact(artifact)).id.toString();
    if (id !== expectedClassId) failures.push(`consumer artifact class id ${id} != chain-verified ${expectedClassId}`);
  }
}

if (failures.length > 0) {
  console.error('verify:lineage FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`verify:lineage OK — class id ${expectedClassId} (chain-verified ${mainnet.verification.date})`);
