import type { Policy, Tier } from "@quorum/contracts";
import type { ForgeAdapter } from "./forge/adapter.js";
import type { DiffEntry } from "./diff.js";
import { computeTierFloor } from "./tier/floor.js";
import { resolveReferencedFloors } from "./references/resolve.js";
import type { ReferencedFloors } from "./tier/references.js";

/**
 * Where the grading policy comes from, and the trusted ref at which its delegated
 * references are resolved - the seam (QRM-4.0 / audit F5) that lets the SAME
 * enforcement composition serve `--local` today and the forge-mode Gate ([0]/[3])
 * tomorrow without either reimplementing it and drifting (which is how a
 * QRM-3.2/3.4-class fix silently fails to hold at the Gate).
 *
 * The provenance decision lives with the CALLER, deliberately:
 *  - ENFORCEMENT: `policy` = the policy blob AT the canonical fork point;
 *    `referenceRef` = that same fork point.
 *  - The `--policy=head` DIAGNOSTIC: `policy` = the WORKING-TREE policy (a dirty
 *    tree the PR can edit), `referenceRef` = "HEAD". This must NOT be reduced to
 *    `forge.getFile("HEAD", ".quorum/policy.json")`: that reads HEAD's COMMITTED
 *    blob, silently changing dirty-working-tree diagnostic semantics (GPT
 *    amendment 2, verified against `loadPolicy` at cli.ts:141-153). The working-
 *    tree read stays a filesystem concern in the CLI; this kernel function never
 *    loads a policy - it only consumes the resolved `PolicySource`.
 *  - FORGE MODE exposes no working-tree diagnostic at all.
 */
export interface PolicySource {
  readonly policy: Policy;
  readonly referenceRef: string;
}

export interface EnforcementResult {
  readonly policy: Policy;
  readonly referencedFloors: ReferencedFloors;
  readonly floor: Tier;
}

/**
 * The single enforcement composition (QRM-3.4 P3, extracted from cli.ts in
 * QRM-4.0): resolve the policy's delegated reference floors at the trusted ref
 * via `repoReader`, then compute the tier floor over the diff. Parameterized over
 * `ForgeAdapter` so local (`LocalGitForge`) and forge (`GitHubForge`) modes share
 * ONE code path.
 *
 * Fail-closed throughout: `resolveReferencedFloors` throws `ReferenceResolutionError`
 * on an unreadable tree (e.g. a forge that cannot list files) or an unresolvable
 * reference, and the caller blocks - never a silent lower-tier pass. Callers MUST
 * load `source.policy` from the SAME ref they set as `source.referenceRef`
 * (the canonical fork point for enforcement), never the PR head.
 */
export async function resolveEnforcement(
  source: PolicySource,
  repoReader: ForgeAdapter,
  diffEntries: readonly DiffEntry[],
): Promise<EnforcementResult> {
  const referencedFloors = await resolveReferencedFloors(
    source.policy,
    repoReader,
    source.referenceRef,
  );
  const floor = computeTierFloor(diffEntries, source.policy, referencedFloors);
  return { policy: source.policy, referencedFloors, floor };
}
