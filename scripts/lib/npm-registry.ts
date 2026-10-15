import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

/** Always the public registry: a configured mirror must not be able to supply publish times or attestations. */
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org';

export interface RegistryDoc {
  version?: string;
  time?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dist?: { attestations?: { url?: string } | null };
  _npmUser?: string;
}

// `npm view --json` carries the package's whole `time` map, which outgrows the 1 MiB default.
const MAX_BUFFER = 64 * 1024 * 1024;
/**
 * npm picks a spec's `@scope:registry`, or for an unscoped spec the default `scope`'s, over
 * `--registry`, so both are overridden too.
 */
export function viewArgs(spec: string): string[] {
  const scope = spec.startsWith('@') ? spec.slice(0, spec.indexOf('/')) : undefined;
  const scoped = scope ? [`--${scope}:registry=${PUBLIC_REGISTRY}`] : [];
  return ['view', spec, '--json', `--registry=${PUBLIC_REGISTRY}`, '--scope=', ...scoped];
}

function parse(spec: string, out: string): RegistryDoc {
  const doc = out.trim() ? JSON.parse(out) : undefined;
  if (!doc || Array.isArray(doc)) throw new Error(`npm view ${spec}: expected exactly one published version`);
  return doc;
}

const failure = (spec: string, e: unknown) => {
  const stderr = String((e as { stderr?: unknown }).stderr ?? '')
    .trim()
    .split('\n')[0];
  return new Error(`npm view ${spec} failed: ${stderr || e}`);
};

const docs = new Map<string, RegistryDoc>();

/** The registry's view of one exact version. Every failure throws: no caller may read "unfetchable" as "absent". */
export function registryDoc(spec: string): RegistryDoc {
  const cached = docs.get(spec);
  if (cached) return cached;
  let out: string;
  try {
    out = execFileSync('npm', viewArgs(spec), { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER }).toString();
  } catch (e) {
    throw failure(spec, e);
  }
  const doc = parse(spec, out);
  docs.set(spec, doc);
  return doc;
}

const execFileAsync = promisify(execFile);

/** {@link registryDoc} for many specs, `concurrency` npm processes at a time; rejects on the first failure. */
export async function registryDocs(specs: readonly string[], concurrency = 16): Promise<Map<string, RegistryDoc>> {
  const queue = [...new Set(specs)];
  const worker = async () => {
    for (let spec = queue.pop(); spec !== undefined; spec = queue.pop()) {
      if (docs.has(spec)) continue;
      let out: string;
      try {
        out = (await execFileAsync('npm', viewArgs(spec), { maxBuffer: MAX_BUFFER })).stdout;
      } catch (e) {
        throw failure(spec, e);
      }
      docs.set(spec, parse(spec, out));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return new Map(specs.map((s) => [s, docs.get(s) as RegistryDoc]));
}
