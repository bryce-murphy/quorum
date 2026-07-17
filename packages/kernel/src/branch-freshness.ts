import type { GitHubForge } from "./forge/github.js";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The protected branch is NOT up to date relative to the PR head: the fork
 * point (merge base) is behind the protected tip, so the fork-point policy is
 * NOT the current protected-branch policy (QRM-4.0-branch-freshness [2], design
 * §1/§3). Carries BOTH certified 40-hex SHAs so a caller/diagnostic can show the
 * exact staleness (`mergeBaseSha` behind `protectedTipSha`).
 *
 * Thrown ONLY for a genuine staleness inequality between two well-formed,
 * resolved, certified SHAs. Every OTHER failure mode of `assertBranchFreshness`
 * (malformed input, malformed forge data, unresolvable ref) throws a DIFFERENT
 * error - so "the branch is stale" is never a misdiagnosis of "we could not
 * check" (design §3.5, the three-class contract, deliberately not collapsed).
 */
export class BranchFreshnessError extends Error {
  constructor(
    message: string,
    readonly mergeBaseSha: string,
    readonly protectedTipSha: string,
  ) {
    super(message);
    this.name = "BranchFreshnessError";
  }
}

/**
 * The `prHeadSha` INPUT handed to `assertBranchFreshness` is not a full-lowercase-
 * 40-hex commit identity (QRM-4.0-branch-freshness [2], design §3.5, the INPUT
 * layer). Thrown as the FIRST statement, before any network call, so the sentinel
 * zero-network-call tests are meaningful.
 *
 * A BESPOKE class, deliberately DISTINCT from `BranchFreshnessError` (a genuine
 * freshness inequality) and from forge-layer `TreeParseError` (a malformed SHA the
 * forge returned) - the three classes are not collapsed, so "the branch is stale"
 * is never a misdiagnosis of "the caller handed us a bad head". It also replaces
 * the previous bare `TypeError`: a `TypeError` pin was defeatable, because building
 * the diagnostic with `JSON.stringify` on unvalidated input made a `BigInt` head
 * throw its OWN native `TypeError` ("Do not know how to serialize a BigInt") BEFORE
 * our error was constructed - satisfying a `toBeInstanceOf(TypeError)` assertion on
 * an UNRELATED error with zero network calls. A dedicated class the diagnostic
 * cannot accidentally impersonate closes that pin.
 */
export class HeadShaCertificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadShaCertificationError";
  }
}

/**
 * Prove that `protectedBranch` is up to date relative to `prHeadSha` by
 * CERTIFIED commit-graph object identity (QRM-4.0-branch-freshness [2], design
 * §3.2). Returns both certified SHAs on success; THROWS to block on every other
 * outcome and NEVER returns a default.
 *
 * The freshness property (design §1):
 *
 *   merge_base(protectedBranch, prHeadSha) === tip(protectedBranch)
 *
 * When this holds, the fork-point policy and the current protected-branch policy
 * are the SAME commit - hence the same bytes - by construction, so the stale-
 * fork / old-permissive-policy downgrade channel cannot exist. We do NOT re-point
 * grading at the tip; we make staleness itself the blockable condition, leaving
 * QRM-3.2's merge-base grading (stable / trusted / diff-consistent fork point)
 * untouched.
 *
 * The sequence order is LOAD-BEARING, not incidental:
 *
 *  1. Certify `prHeadSha` as full-lowercase-40-hex - the FIRST statement, BEFORE
 *     any network call ([1] Fix-A pattern; Codex BLOCKed [1] for exactly this
 *     omission). A branch-like / short / uppercase / non-hex / empty / non-string
 *     head throws HERE, so the sentinel zero-network-call tests are meaningful.
 *  2. `resolveMergeBase(protectedBranch, prHeadSha)` -> certified `mergeBaseSha`.
 *     `absent` -> block (correct-by-layer, NOT `BranchFreshnessError`).
 *  3. `resolveRefCommit(protectedBranch)` -> certified `protectedTipSha`.
 *     `absent` -> block (correct-by-layer, NOT `BranchFreshnessError`).
 *  4. `mergeBaseSha !== protectedTipSha` -> throw `BranchFreshnessError` (both SHAs).
 *
 * The call-order invariant (design §3.2, probe C4). Merge base is read FIRST,
 * protected tip SECOND. If `protectedBranch` advances between the two reads, the
 * tip read returns a commit NEWER than the compare-time merge base, equality
 * fails, and the check OVER-blocks. The reverse order admits a FALSE-FRESH window
 * (tip read before it advances, then a merge base computed against the advanced
 * branch that equals the now-stale tip snapshot). Over-blocking is the safe
 * direction under CHARTER §4: a silently-wrong verified claim is worse than an
 * over-cautious block. On any transient failure, callers must fail closed or
 * re-run this function WHOLE (both reads, in order) - never retry one read in
 * isolation (see the Octokit construction-site comment in forge/github.ts).
 *
 * `protectedBranch` is an invocation parameter, exactly as `forgePolicySource`
 * takes `protectedBaseBranch` - NEVER derived from PR event data (design §3.4,
 * the inherited [0] base-mismatch contract). Freshness is what MAKES the
 * fork-point policy current, so it cannot itself depend on a PR-controlled
 * branch name for what it checks against.
 */
export async function assertBranchFreshness(
  forge: GitHubForge,
  protectedBranch: string,
  prHeadSha: string,
): Promise<{ mergeBaseSha: string; protectedTipSha: string }> {
  // Step 1 - input certification, BEFORE any network call (zero-network-call
  // sentinel tests depend on this being the first statement). A malformed head is
  // an INPUT-layer failure: HeadShaCertificationError, deliberately NOT a
  // BranchFreshnessError and NOT a forge-layer TreeParseError (design §3.5). The
  // `||` short-circuits, so `FULL_COMMIT_SHA.test` is only ever reached for an
  // actual string (a raw `.test(Symbol())` would itself throw). The diagnostic
  // stringifies ONLY a confirmed string - never `JSON.stringify`/`${}` on the raw
  // input, either of which throws a NATIVE error on a BigInt/Symbol BEFORE our
  // error is built, defeating the class pin - and shows the typeof otherwise, so
  // message construction can never throw.
  if (typeof prHeadSha !== "string" || !FULL_COMMIT_SHA.test(prHeadSha)) {
    const shown =
      typeof prHeadSha === "string" ? JSON.stringify(prHeadSha) : `<non-string: ${typeof prHeadSha}>`;
    throw new HeadShaCertificationError(
      `assertBranchFreshness: prHeadSha is not a full 40-hex commit SHA: ${shown}`,
    );
  }

  // Step 2 - merge base FIRST (order is load-bearing). resolveMergeBase returns
  // an already-certified 40-hex sha (or throws TreeParseError on malformed
  // first-party data - forge layer, propagated). `absent` -> block, correct-by-
  // layer.
  const mb = await forge.resolveMergeBase(protectedBranch, prHeadSha);
  if (mb.kind !== "ok") {
    throw new Error(
      `assertBranchFreshness: could not resolve the merge base of ${JSON.stringify(protectedBranch)}` +
        `...${JSON.stringify(prHeadSha)} to a commit - blocking (correct-by-layer, not a freshness failure)`,
    );
  }
  const mergeBaseSha = mb.value;

  // Step 3 - protected tip SECOND. Same certification contract; `absent` ->
  // block, correct-by-layer.
  const tip = await forge.resolveRefCommit(protectedBranch);
  if (tip.kind !== "ok") {
    throw new Error(
      `assertBranchFreshness: could not resolve the protected branch ${JSON.stringify(protectedBranch)} ` +
        `to a tip commit - blocking (correct-by-layer, not a freshness failure)`,
    );
  }
  const protectedTipSha = tip.value;

  // Step 4 - certified SHA equality is the direct proof that the fork-point tree
  // and the current protected tree are the SAME commit object. Inequality (stale
  // fork, OR a mid-check tip advance) blocks with BOTH SHAs attached.
  if (mergeBaseSha !== protectedTipSha) {
    throw new BranchFreshnessError(
      `branch ${JSON.stringify(protectedBranch)} is not up to date: fork point ${mergeBaseSha} ` +
        `is behind the protected tip ${protectedTipSha}`,
      mergeBaseSha,
      protectedTipSha,
    );
  }

  return { mergeBaseSha, protectedTipSha };
}
