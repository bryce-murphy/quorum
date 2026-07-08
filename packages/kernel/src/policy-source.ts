import { PolicySchema } from "@quorum/contracts";
import type { PolicySource } from "./enforcement.js";
import type { GitHubForge } from "./forge/github.js";

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
    throw new PolicyReadError(`${label} is not a full 40-hex commit SHA: ${JSON.stringify(value)}`);
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
 * Sequence, all fail-closed:
 *  1. Certify `prHeadSha` as a full 40-hex commit SHA BEFORE any compare/
 *     getFile call - a branch-like/short/uppercase/non-hex head throws here,
 *     before the network is touched at all.
 *  2. Resolve the fork point via `forge.resolveMergeBase(protectedBaseBranch,
 *     certifiedHeadSha)` (itself returns an already-certified sha - see
 *     `GitHubForge.resolveMergeBase`); re-certified here too as
 *     defense-in-depth so this function's own fail-closed invariant does not
 *     depend on the callee's. An unresolvable base/head (`absent`) or an
 *     uncertified shape -> throw.
 *  3. Read `.quorum/policy.json` at that resolved SHA
 *     (`forge.getFile(mergeBaseSha, ...)`). Absent - 404, or a non-file type
 *     e.g. a symlinked policy - -> throw. Never a default.
 *  4. Parse + validate with the SAME `PolicySchema` the local path uses. Bad
 *     JSON or a schema-rejected policy -> throw.
 *  5. Return `{ policy, referenceRef: mergeBaseSha }` - the resolved commit
 *     SHA, never `protectedBaseBranch` or `prHeadSha` - so
 *     `resolveReferencedFloors` reads delegated configs from the IDENTICAL
 *     commit the policy came from. TOCTOU between "resolve fork point" and
 *     "read policy/references" is structurally impossible: one SHA, threaded
 *     everywhere by the shared `resolveEnforcement` seam.
 *
 * Does not claim [2] (branch-freshness), [3] (trusted/pinned verifier), or
 * [0] (wiring `quorum-verify` as a required check / the L2 Gate). No CLI
 * caller routes here - the CLI stays `--local`; forge-mode wiring is [0].
 */
export async function forgePolicySource(
  forge: GitHubForge,
  protectedBaseBranch: string,
  prHeadSha: string,
): Promise<PolicySource> {
  const certifiedHeadSha = certifyCommitSha(prHeadSha, "prHeadSha");

  const mb = await forge.resolveMergeBase(protectedBaseBranch, certifiedHeadSha);
  if (mb.kind !== "ok") {
    throw new PolicyReadError(
      `could not resolve the fork point between ${JSON.stringify(protectedBaseBranch)} ` +
        `and ${JSON.stringify(certifiedHeadSha)}`,
    );
  }
  const mergeBaseSha = certifyCommitSha(mb.value, "merge_base_commit.sha");

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
