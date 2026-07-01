# Phase 1 lessons — repo bootstrap

## Gate results (2026-07-01)

| Item | Result |
|---|---|
| `bun install` | ✓ 107 packages (biome 2.5.1, husky 9.1.7, lint-staged 17.0.8, commitlint 21.1.0, sort-package-json 4.0.0, tsc 6.0.3 — all resolved under the 7-day min-age gate) |
| `bun run lint` | ✓ (biome 5 files clean + sort-package-json sorted) |
| `bun run lint:shell` | ✓ shellcheck clean |
| `bun run lint:actions` | ✓ actionlint 1.7.12 clean |
| Hooks fire | ✓ pre-commit lint-staged ran on both real commits; commit-msg REJECTED "bad message no type" (husky exit 1, no commit created) |
| bunfig min-age verified | ✓ empirically (see below) |
| npm preflight — names free | ✓ all three `@alejoamiras/*` names 404 |
| npm preflight — `npm whoami` | ✗ **401 — user not logged in to npm locally. USER ACTION: `npm login`.** Only unfinished gate item; phase ✓ blocked on it. |
| `gh repo create` + push | ✓ https://github.com/alejoamiras/ecosystem-tooling (PUBLIC), main pushed |

## Empirical findings (load-bearing)

1. **Inference I3 RESOLVED: FALSE.** bun 1.3.13 `minimumReleaseAgeExcludes` does NOT support globs — `["@aztec/*"]` still blocked `@aztec/aztec.js@5.0.0-rc.2` (2 days old). Exact names DO work (excluding `@aztec/aztec.js` let it resolve) **but transitives are gated independently** (`@aztec/foundation`, `entrypoints`, `l1-artifacts`, `protocol-contracts`, `standard-contracts` all blocked next). ⇒ The exclusion list must enumerate the FULL `@aztec/*` closure; `scripts/bump-aztec.ts`'s two-phase design (registry-metadata closure pre-install, lockfile regeneration post-install) is confirmed as the right mechanism. bunfig.toml documents this; excludes stay EMPTY until Phase 6 (rc.1 = published 2026-06-15, 16 days old, clears the gate on its own).
2. Local toolchain snapshot: bun 1.3.13, node v24.16.0, npm 11.13.0 (≥11.5.1 → OIDC-capable), aztec CLI 5.0.0-rc.1 already installed, actionlint 1.7.12 (= latest release; CI workflow pins it with sha256).
3. `bun add`'s exit code is masked when piped (`| tail`); rely on error text / re-run for status. Minor harness note.
4. Bash tool cwd persists between calls — a min-age test in the scratchpad left the shell there; one "Script not found lint" red herring. Use absolute cd prefixes.

## Consults

None needed (no contested decisions; I3 resolved empirically rather than by debate).
