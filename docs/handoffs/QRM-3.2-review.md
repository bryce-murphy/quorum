# QRM-3.2 — cross-family review record

Task: evaluate the tier-floor policy from the merge-base, not the PR head. loadPolicy(cwd) read .quorum/policy.json from the working tree (the PR head's policy), so a PR was graded against the policy it could itself edit — self-lowering a floor rule AND self-exempting via exempt_paths. Fix: loadPolicyAtRef reads the whole policy object from the canonical merge-base fork point; verify/tier grade against base policy on both axes. Reviewers: GPT (cross-architect, design) and Codex (cross-family, red-team). Principles 1, 2, 5, 12. Git-tracked so the evidence is not chat-only (principle 5).

## Cross-architect (GPT) design review — pre-prototype
PROCEED-TO-PROTOTYPE with four revisions, all accepted:
1. Load the WHOLE policy object from base (not just floor rules) — feed the same base policy to BOTH computeTierFloor AND computeUncoveredPaths(exempt_paths). Loading only floor rules would leave the exempt_paths sibling hole open (a PR could self-exempt its changed files).
2. cmdTier decided as base-policy by default; head-policy inspection only via a labeled, non-default --policy=head diagnostic.
3. Gate prerequisites recorded as tracked requirements, not prose — consolidated in the planned QRM-4.0 (L2-Gate) manifest.
4. Fixed an internal doc inconsistency (cmdTier did not previously hold a merge-base). Plus: schema-evolution fail-closed expectation; an explicit owner-ratified bootstrap mode named (not built) for a repo whose base predates policy.
Q4 decided: grade by merge-base (fork point), not base-branch tip — stable, trusted, consistent with the diff (mergeBase..HEAD); the stale-tightening residual is closed at the Gate via require-up-to-date-branches (tracked in QRM-4.0).

## Cross-family red-team (Codex)
### Round 1 — verdict BLOCK, then resolved
- R1: --base could select an OLDER merge-base and therefore an older, weaker policy (resolveMergeBase's carving guard accepts earlier ancestors, which is safe for diff-widening but downgrades policy). Repro: main advances to add src/**->T3; `verify --base <pre-tightening-commit>` graded against the old policy -> clear/T0 on a file main floors to T3.
- Fix: decouple the policy ref from the diff base. Policy loads from canonicalForkPoint(cwd) = resolveMergeBase(undefined) = merge-base(HEAD, main), which --base cannot move; --base still legitimately widens the DIFF range (guarded against carving as before).
- IMPORTANT — the re-reported BLOCK was a STALE-dist artifact: Codex's hand-repro ran the CLI against a dist/cli.js built before the amend. Against a freshly built dist the bypass is closed; Codex re-confirmed CLEAR after `npm run build`. Lesson recorded below.

### Review follow-ons on the open PR
- P2: cmdTier removed --diff <range> handling but still ACCEPTED the --diff flag, silently grading mergeBase..HEAD instead — e.g. `tier --diff HEAD~1..HEAD` on main returned T0 for the empty self-delta, hiding a high-tier change. Fixed: --diff now fails closed (exit 2) pointing to --base / --policy=head.
- P3: the P2 guard only checked flags["diff"]; a valueless --diff (`tier --diff`, or `--diff` followed by another flag) routes into bools. Fixed: guard now checks flags["diff"] !== undefined || bools.has("diff").
- Final Codex review on commit 2df53df: no major issues.

## Disposition
Shipped as PR #10 (squash e5ba166). Independently re-verified from a clean clone at each amended tip (R1 bypass-closure + P2 + P3 green; full suite 155). This PR secures policy DATA, not verifier CODE.

## Deferred — tracked in QRM-4.0 (L2-Gate prerequisites home)
Authenticated forge-mode base-policy read; mechanical branch-freshness (closes the stale-tightening residual); trusted/pinned verifier code; mode-bearing diff (QRM-3.1); GitHubForge mode parity. The Gate is not claimed as complete tier-floor enforcement until every prerequisite is met (principle 2).

## Harness-hardening notes (banked, not yet tasks)
1. Red-team hand-repros must rebuild dist (npm run build) as step zero — a stale dist/cli.js caused a phantom R1 BLOCK round.
2. A red-team probe wrote a stray file named `base` into the repo root; `git add -A` swept it into an amend once (removed before final). The red-team harness should be isolated from the working tree.
3. parseFlags routes `--flag value` into flags and bare `--flag` into bools; consumers must check BOTH for any rejected/required flag (root of P2 then P3). A small parseFlags helper that unifies the lookup would prevent recurrence.

## Provenance
Re-verified from main after merge: squash e5ba166, parent f14588c; QRM-3.2 manifest flipped to merged in this bookkeeping change; QRM-4.0 remains planned.
