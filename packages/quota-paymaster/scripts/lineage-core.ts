/**
 * Reconstructs the upstream QuotaFpc main.nr from the vendored copy by reversing every
 * sanctioned deviation — so verify:lineage can require byte-identity with the recorded
 * upstream hash and any unlisted edit fails.
 */

/** A reviewed source change: `vendored` replaced `upstream`, as contiguous whole lines. */
export interface SanctionedEdit {
  reason: string;
  upstream: string[];
  vendored: string[];
}

/** The TXE suite exercises these two library methods directly; upstream keeps them private. */
const PUB_MARKERS = ['assert_fee_within_max', 'assert_generation_fresh'];
const TEST_MODULE_LINE = 'pub mod test;';

function blockIndexes(lines: string[], block: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (block.every((line, j) => lines[i + j] === line)) hits.push(i);
  }
  return hits;
}

/** Throws naming the first edit whose vendored block is absent or ambiguous. */
export function reconstructUpstream(vendored: string, edits: readonly SanctionedEdit[]): string {
  let lines = vendored.split('\n');
  for (const edit of edits) {
    if (edit.vendored.length === 0) throw new Error(`sanctioned edit "${edit.reason}" has an empty vendored block`);
    const at = blockIndexes(lines, edit.vendored);
    if (at.length !== 1) {
      throw new Error(
        `sanctioned edit "${edit.reason}": vendored block found ${at.length} times, expected exactly once`,
      );
    }
    const i = at[0] as number;
    lines = [...lines.slice(0, i), ...edit.upstream, ...lines.slice(i + edit.vendored.length)];
  }

  const modIdx = lines.indexOf(TEST_MODULE_LINE);
  if (modIdx === -1) throw new Error(`the sanctioned \`${TEST_MODULE_LINE}\` registration line is missing`);
  lines.splice(modIdx, 1);

  return lines
    .map((line) => {
      const marker = PUB_MARKERS.find(
        (name) => line.trimStart() === `pub fn ${name}` || line.trimStart().startsWith(`pub fn ${name}(`),
      );
      return marker ? line.replace(`pub fn ${marker}`, `fn ${marker}`) : line;
    })
    .join('\n');
}
