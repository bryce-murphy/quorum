import type { Claim, ClaimResult, ClaimType } from "@quorum/contracts";
import { globMatches, normalizeGlobSeparators, normalizePath } from "./tier/glob.js";

/** Claim types whose verification depends on the forge (not local git). When the
 *  forge cannot answer them, the honest verifier returns unverifiable_disclosed -
 *  but these are security-relevant (a claimed test pass / review is evidence), so
 *  in strict mode an unverifiable one fails closed at ALL tiers (FIX 4). */
const FORGE_ONLY: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "test_passed",
  "review_posted",
  "pr_opened",
  "issue_filed",
]);

/** Claim types whose subject is a file path (used for diff coverage). */
const FILE_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "file_created",
  "file_modified",
  "file_deleted",
]);

/**
 * FIX 4 - fail closed on unverifiable security-relevant claims in strict mode.
 * A forge-only claim that came back `unverifiable_disclosed` is reclassified to
 * `failed` so it blocks, regardless of tier. Non-forge (file) disclosures keep
 * their honest status and the tiered fail-open/closed handling in the verdict.
 */
export function applyStrictFailClosed(
  results: readonly ClaimResult[],
  mode: "strict" | "salvage",
): ClaimResult[] {
  if (mode !== "strict") return [...results];
  return results.map((r) => {
    if (r.status === "unverifiable_disclosed" && FORGE_ONLY.has(r.type)) {
      return {
        ...r,
        status: "failed" as const,
        evidence: {
          ...r.evidence,
          fail_closed: true,
          reason: r.evidence["reason"] ?? "security_relevant_unverifiable",
        },
      };
    }
    return r;
  });
}

/**
 * FIX 1 - diff-coverage requirement. Return the changed paths that are NOT
 * covered by a verified/verified_exists file claim and NOT exempt by policy.
 * The verifier must verify the CHANGE, not just whatever claims happen to exist:
 * an unclaimed changed path is exactly how a backdoor rides in under a clean
 * ledger.
 */
export function computeUncoveredPaths(
  claims: readonly Claim[],
  results: readonly ClaimResult[],
  changedPaths: readonly string[],
  exemptGlobs: readonly string[] = [],
): string[] {
  const statusById = new Map(results.map((r) => [r.claim_id, r.status]));
  const covered = new Set<string>();
  for (const claim of claims) {
    if (!FILE_TYPES.has(claim.type)) continue;
    const status = statusById.get(claim.id);
    if (status !== "verified" && status !== "verified_exists") continue;
    const path = (claim.subject as { path: string }).path;
    covered.add(normalizePath(path));
  }
  const exempt = exemptGlobs.map(normalizeGlobSeparators);
  const uncovered: string[] = [];
  for (const raw of changedPaths) {
    const path = normalizePath(raw);
    if (covered.has(path)) continue;
    if (exempt.some((g) => globMatches(g, path))) continue;
    uncovered.push(path);
  }
  return uncovered;
}
