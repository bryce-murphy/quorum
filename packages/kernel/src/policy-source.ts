import { PolicySchema } from "@quorum/contracts";
import type { PolicySource } from "./enforcement.js";
import type { GitHubForge } from "./forge/github.js";
import { assertBranchFreshness } from "./branch-freshness.js";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Any fail-closed step of `forgePolicySource` (QRM-4.0-policy-read [1]): an
 * unresolvable/uncertified fork point, an absent/unreadable/non-file policy at
 * that fork point, or a policy that fails to parse or validate. Always thrown,
 * never swallowed into a default policy - the caller must block.
 */
export class PolicyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyReadError";
  }
}

function certifyCommitSha(value: unknown, label: string): string {
  // Missing / non-string / short-or-ambiguous / branch-like (`main`,
  // `refs/heads/main`) / uppercase / wrong-length all fail this single regex -
  // this certification is load-bearing (design §3 amendment 1): the entire
  // single-SHA binding below depends on `referenceRef` being IMMUTABLE. A
  // merely-string value that is actually a mutable ref would reintroduce ref
  // resolution inside every downstream `getFile`/`listFiles` call and silently
  // defeat the TOCTOU guarantee this function exists to provide.
  if (typeof value !== "string" || !FULL_COMMIT_SHA.test(value)) {
    // Diagnostic must never throw during construction: `JSON.stringify(value)` on
    // a BigInt throws its OWN native TypeError (and `${value}` throws on a Symbol)
    // BEFORE PolicyReadError is built, which would preempt this fail-closed block
    // with an unrelated native throw and let a `.rejects` pin pass on it. Stringify
    // ONLY a confirmed string; show the typeof otherwise (same safe-diagnostic fix
    // as assertBranchFreshness's HeadShaCertificationError guard).
    const shown = typeof value === "string" ? JSON.stringify(value) : `<non-string: ${typeof value}>`;
    throw new PolicyReadError(`${label} is not a full 40-hex commit SHA: ${shown}`);
  }
  return value;
}

/**
 * Forge-mode `PolicySource` constructor (QRM-4.0-policy-read [1]) - the forge
 * counterpart of cli.ts's local `loadPolicyAtRef(canonicalForkPoint(cwd))`,
 * one level up over the authenticated GitHub API. Behaviorally equivalent to
 * local (both fail closed on absent/bad-JSON/schema-fail/non-file policy),
 * not byte-identical in mechanism.
 *
 * `protectedBaseBranch` is a PINNED verifier-configuration constant - the
 * repository's protected default branch, supplied by the CALLER from trusted
 * config. It is NEVER read from a PR object: a GitHub PR's base branch is
 * retargetable by its author, so trusting a PR-supplied base would let an
 * attacker point policy resolution at a throwaway branch carrying a
 * permissive `.quorum/policy.json` (the forge analog of QRM-3.2's red-team
 * R1). This function has no parameter through which a PR-supplied base could
 * enter - the pin is structural, not a runtime check.
 *
 * `prHeadSha` is the authenticated PR head COMMIT SHA (`getPR().headSha`),
 * never a mutable/collidable branch label (`headRef`) - a fork PR's
 * unqualified branch name is neither immutable nor globally unique. This is
 * CERTIFIED (full 40-hex) before it reaches any network call: a caller that
 * passes `headRef` instead of `headSha` by mistake must fail loudly, not
 * silently resolve a merge-base against an attacker-influenceable branch
 * label (Codex round 1, BLOCK - the pre-fix code only certified the
 * *returned* merge-base sha, never the head sha it was computed FROM).
 *
 * FRESHNESS-BOUND (QRM-4.0-branch-freshness [2], design §3.3 / GPT amendment 2).
 * This function calls `assertBranchFreshness` internally and grades against the
 * fork point IT returns, so it is structurally impossible to obtain a Gate-facing
 * policy without a freshness attestation. That closes the stale-fork /
 * old-permissive-policy channel [1] deferred to [2]: the fork-point policy is
 * only "current" when `merge_base(protectedBaseBranch, head) === tip(protected)`.
 * Weighing the two failure modes, a forgotten composition at [0] would be a
 * silent under-floor (an under-floor), while over-coupling merely over-blocks
 * stale branches (an over-block) - the calibration binds the seam. Safe to do
 * now precisely because [1] shipped this with ZERO forge-mode callers, so there
 * is no caller to break. `assertBranchFreshness` stays exported as a primitive.
 *
 * Sequence, all fail-closed:
 *  1. Certify `prHeadSha` as a full 40-hex commit SHA BEFORE any network call -
 *     a branch-like/short/uppercase/non-hex head throws here (`PolicyReadError`),
 *     before the network is touched at all. This is a redundant BACKSTOP: step 2
 *     re-certifies it as `assertBranchFreshness`'s own first statement. Kept so
 *     the [1] Codex-BLOCK regression pin stays live at THIS surface even if the
 *     callee's certification later changes.
 *  2. `assertBranchFreshness(forge, protectedBaseBranch, certifiedHeadSha)` -
 *     certifies the head, resolves the merge base (FIRST) and the protected tip
 *     (SECOND), and returns the certified fork point ONLY if the branch is up to
 *     date. A stale fork -> `BranchFreshnessError`; an unresolvable base/head ->
 *     a correct-by-layer block; a malformed forge SHA -> `TreeParseError`. All
 *     propagate uncaught (catch-all: any throw blocks).
 *  3. Re-certify the returned fork point (the ~line-99 [1] regression backstop -
 *     redundant with the callee, fires only if that regresses; KEEP).
 *  4. Read `.quorum/policy.json` at that resolved SHA
 *     (`forge.getFile(mergeBaseSha, ...)`). Absent - 404, or a non-file type
 *     e.g. a symlinked policy - -> throw. Never a default.
 *  5. Parse + validate with the SAME `PolicySchema` the local path uses. Bad
 *     JSON or a schema-rejected policy -> throw.
 *  6. Return `{ policy, referenceRef: mergeBaseSha }` - the resolved commit
 *     SHA, never `protectedBaseBranch` or `prHeadSha` - so
 *     `resolveReferencedFloors` reads delegated configs from the IDENTICAL
 *     commit the policy came from. TOCTOU between "resolve fork point" and
 *     "read policy/references" is structurally impossible: one SHA, threaded
 *     everywhere by the shared `resolveEnforcement` seam.
 *
 * Does not claim [3] (trusted/pinned verifier) or [0] (wiring `quorum-verify`
 * as a required check / the L2 Gate). No CLI caller routes here - the CLI stays
 * `--local`; forge-mode wiring is [0]. [2] proves freshness at VERIFICATION time
 * only; the grade-to-merge race (protected advancing between verify and merge)
 * is closed at [0] by strict required-check semantics, not here.
 */
export async function forgePolicySource(
  forge: GitHubForge,
  protectedBaseBranch: string,
  prHeadSha: string,
): Promise<PolicySource> {
  // Backstop cert (step 1): certify the immutable head BEFORE any network call
  // ([1] Codex BLOCK). `assertBranchFreshness` re-certifies as its own first
  // statement; this keeps the [1] regression pin live at THIS surface.
  const certifiedHeadSha = certifyCommitSha(prHeadSha, "prHeadSha");

  // Freshness binding (step 2, design §3.3): grade only against the fork point
  // an up-to-date protected branch yields. A stale fork, an unresolvable
  // base/head, or a malformed forge SHA throws (any throw blocks) - no policy is
  // ever obtained on a stale fork.
  const { mergeBaseSha: attestedForkPoint } = await assertBranchFreshness(
    forge,
    protectedBaseBranch,
    certifiedHeadSha,
  );

  // ~line-99 regression backstop (step 3, KEEP): re-certify the fork point this
  // function threads into every getFile/reference read. Redundant now that both
  // resolveMergeBase and assertBranchFreshness certify by construction; fires
  // only if that regresses.
  const mergeBaseSha = certifyCommitSha(attestedForkPoint, "merge_base_commit.sha");

  const file = await forge.getFile(mergeBaseSha, ".quorum/policy.json");
  if (file.kind !== "ok") {
    throw new PolicyReadError(`policy not found at ${mergeBaseSha}:.quorum/policy.json`);
  }

  let json: unknown;
  try {
    json = JSON.parse(file.value.content);
  } catch {
    throw new PolicyReadError(`policy.json at ${mergeBaseSha} is not valid JSON`);
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    throw new PolicyReadError(`policy.json at ${mergeBaseSha} invalid: ${parsed.error.issues[0]?.message}`);
  }

  return { policy: parsed.data, referenceRef: mergeBaseSha };
}
