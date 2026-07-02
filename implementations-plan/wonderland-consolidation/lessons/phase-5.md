# Phase 5 lessons — CI pipeline + canary (PIPELINE PROVEN; canary = user OTP runbook)

## Gate results

| Item | Result |
|---|---|
| actionlint | ✓ throughout (local + `actionlint.yml` + lint-staged hook) |
| PR exercising all three gates | ✓ **PR #1: 14/14 checks green** on head 65344a3 (both TXE lanes, both integration lanes — standards 15m10s, both benchmark lanes — standards 25m21s incl. PR comment posting via the split write-job); re-running on the final head after review/audit fixes |
| Runner capacity (I1) | ✓ ubuntu-latest handles everything: setup 238s, TXE 539s, one integration test 58s (spike), full matrices well inside timeouts |
| verify-tarball (npm-client clean-room) | ✓ 15/15 surfaces across all three packages (see phase-6 F8 correction) |
| Baseline seeding on main | pending merge (update-baselines.yml fires on the merge push) |
| Canary publish e2e | **BLOCKED on npm OTP** (see below) — everything up to `npm publish` is proven |

## The canary/auth story (plan A2 evolved)

- npm account 2FA mode = `auth-and-writes`: EVERY write (publish, token create) needs an OTP → no unattended path exists (correct behavior by npm; discovered via `npm profile get`).
- GitHub environment `npm-publish` created via API: required reviewer = alejoamiras, deployments restricted to `main`.
- 1Password lock cascade update: ssh agent flapped; **`git push`/`gh` via HTTPS + gh token auth bypasses the ssh agent entirely** — adopted for all remote git ops. Signing: 8 mid-session commits re-signed cleanly pre-push (nothing unsigned was ever pushed to main); later branch commits are unsigned pending the user's backfill decision (squash-merge makes them moot).

## CI findings fixed live on PR #1

1. Benchmark jobs invoked the workspace CLI without building it (dist/ gitignored) — caught by the FIRST real PR run, fixed with an explicit build step. The vendored-workflow adaptations (namespaced artifacts, job split, non-vacuous assertions, `--skip-proving`) all worked first try.
2. Review/audit hardening applied on top (see audit-codex.md post-impl section + code-review disposition in the PR body/commits b801a74, d128031).

## USER RUNBOOK (the only remaining manual steps — ~10 min total)

1. On npmjs.com: create a **granular** automation token — scope `@alejoamiras` (packages don't exist yet → scope-level), permission publish, expiry ≤30 days.
2. `gh secret set NPM_TOKEN --env npm-publish --repo alejoamiras/ecosystem-tooling` (paste token).
3. Actions → **Canary Publish** → Run workflow (main) → approve the environment gate. Verify: `npm view @alejoamiras/aztec-standards dist-tags`.
4. npmjs.com → each of the 3 packages → Settings → Trusted publisher: repo `alejoamiras/ecosystem-tooling`, workflow `release.yml`, environment `npm-publish` (+ allowed action `npm publish` if offered). Then REVOKE the token from step 1.
5. Actions → **Release** → Run workflow (main) with version `5.0.0-rc.2` → approve the gate. The workflow re-validates everything, verify-tarballs, publishes benchmark→standards→fee-payment with provenance under the `rc` tag, asserts dist-tags + attestations, tags `v5.0.0-rc.2`, and creates the GitHub release.
