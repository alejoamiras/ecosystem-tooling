// Registry packument → dist-tags, for scripts/read-dist-tags.sh. Every value must be a version
// string: a malformed one (null, [], a number) is an error, never "absent" — an empty read is
// what the forward-only and unchanged-latest checks would take as "no tag" and skip.

import { pathToFileURL } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} body the packument JSON text
 * @param {string} [tag] one tag to read; omitted returns the whole object as JSON
 * @returns {string} the tag's version ('' only when the tag is genuinely absent), or the object
 */
export function readDistTags(body, tag) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error('registry response is not JSON');
  }
  const tags = doc?.['dist-tags'];
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error('no dist-tags object in the packument');
  }
  for (const [name, version] of Object.entries(tags)) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw new Error(`dist-tag ${name} is ${JSON.stringify(version)}, not a version`);
    }
  }
  if (!tag) return JSON.stringify(tags);
  return Object.hasOwn(tags, tag) ? tags[tag] : '';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    body += chunk;
  });
  process.stdin.on('end', () => {
    try {
      process.stdout.write(readDistTags(body, process.argv[2]));
    } catch (e) {
      console.error(`read-dist-tags: ${e.message}`);
      process.exit(1);
    }
  });
}
