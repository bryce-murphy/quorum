# QRM-1 - Phase 1 vertical slice (L0 contracts + L1 kernel)

Draft PR body for `qrm-1-phase1-slice` -> `main`. Opened only on owner go.

## What this ships

- **M1 `@quorum/contracts`**: zod schemas (claim / ledger / task-manifest / policy) as the source of truth, deterministic JSON Schema generation, byte-stable drift check.
- **M2 `@quorum/kernel`**: deterministic verifier - extract (strict + salvage), per-claim-type verification, ledger build/render, code-enforced tier floor, artifact validation, `ForgeAdapter` with `LocalGitForge` (offline off-ramp) + `GitHubForge`, and the `quorum` CLI (exit 0/1/2). Zero LLM calls; no network outside `ForgeAdapter`.

Verifies itself from the first PR: `.quorum/claims/QRM-1.jsonl` covers every changed path; `quorum verify --local --task QRM-1` -> clear (T3, strict), exit 0.

## Review history (all addressed on this branch)

- **Cross-family review (GPT/Codex)** - 5 findings: path normalization for the tier floor, GitHub reviews pagination + null-timestamp, raw-byte hashing, salvage false positives, `policy.yml`->`policy.json` doc fix.
- **Red-team (GPT/Codex)** - 7 hardening fixes: diff-coverage requirement (the headline gap), blob-required `getFile`, in-delta `commit_pushed`, forge-only fail-closed, `verified_exists` honesty status, duplicate-id rejection, and fail-loud merge-base resolution.

## Known gaps - REQUIRED follow-ups in M3 (the Gate)

These are out of scope for the L0+L1 slice and are tracked for M3, when the GitHub Action and App identity exist:

1. **Reviewer identity not enforced.** `review_posted` confirms an emission exists across the three endpoints but does not check the author. Cross-family reviewer identity (principle 7) cannot be enforced until the Gate runs under the App identity. **REQUIRED M3 fix.**
2. **Strict trust boundary.** Strict mode currently also accepts a `quorum-claims` fence in the PR body as a secondary source. The Gate must trust **only** the committed `.quorum/claims/*.jsonl` - untrusted PR-body text must never be a claim source under strict mode. **M3 Gate wiring.**
3. **Salvage fence robustness.** The salvage miner can still mine claim-like text from unclosed / malformed code fences (advisory-only false positives). Harden fence parsing in M3.
4. **Salvage is fail-open by design - the Gate must pin the mode.** Salvage mode is advisory and does **not** enforce diff-coverage (that is correct behavior for salvage). The M3 Gate MUST pin `--mode strict` and must never accept the mode from PR-controlled input, or an attacker could select salvage to bypass coverage. The control belongs at the Gate, not the kernel.

## Acceptance

- CI green: build + full kernel test suite + schema-drift check.
- `quorum verify --local --task QRM-1` runs clean on the committed claims file.
- A seeded fabricated claim and an unclaimed changed path both visibly block a strict-mode verify.
