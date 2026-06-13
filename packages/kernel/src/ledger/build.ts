import type { ClaimResult, Ledger, Tier } from "@quorum/contracts";
import { SCHEMA_IDS, tierRank } from "@quorum/contracts";
import type { LedgerContext } from "../types.js";

/**
 * Fail-closed / fail-open verdict (SPEC 5 + red-team hardening):
 *  - salvage mode is advisory: it reports but never blocks -> always pass.
 *  - strict mode:
 *      * any `failed` claim blocks;
 *      * the verifier must verify the CHANGE: any uncovered changed path blocks
 *        at every tier, and a non-empty diff with ZERO covering claims blocks
 *        (never "clear" over an unclaimed change) - FIX 1;
 *      * `unverifiable_disclosed` blocks at T2+ (fail-closed for risky work),
 *        passes at T0/T1 (fail-open for trivia).
 * `verified_exists` is a passing, covering status (honest weaker label).
 */
export function computeVerdict(
  results: readonly ClaimResult[],
  mode: "strict" | "salvage",
  tier: Tier,
  uncoveredPaths: readonly string[],
  diffNonEmpty: boolean,
): "pass" | "fail" {
  if (mode === "salvage") return "pass";
  if (results.some((r) => r.status === "failed")) return "fail";

  const covering = results.filter(
    (r) => r.status === "verified" || r.status === "verified_exists",
  ).length;
  if (diffNonEmpty && covering === 0) return "fail"; // zero claims over a real change
  if (uncoveredPaths.length > 0) return "fail"; // any uncovered changed path blocks

  const disclosedBlocks = tierRank(tier) >= tierRank("T2");
  if (disclosedBlocks && results.some((r) => r.status === "unverifiable_disclosed")) {
    return "fail";
  }
  return "pass";
}

/** Assemble the ledger of record from per-claim results (SPEC 3.4). */
export function buildLedger(results: readonly ClaimResult[], ctx: LedgerContext): Ledger {
  const count = (s: ClaimResult["status"]) => results.filter((r) => r.status === s).length;
  const uncovered = ctx.uncovered_paths ?? [];
  return {
    schema: SCHEMA_IDS.ledger,
    task: ctx.task,
    head: ctx.head,
    mode: ctx.mode,
    results: [...results],
    counts: {
      total: results.length,
      verified: count("verified"),
      verified_exists: count("verified_exists"),
      failed: count("failed"),
      unverifiable_disclosed: count("unverifiable_disclosed"),
    },
    uncovered_paths: [...uncovered],
    tier_effective: ctx.tier_effective,
    verdict: computeVerdict(
      results,
      ctx.mode,
      ctx.tier_effective,
      uncovered,
      ctx.diff_non_empty ?? uncovered.length > 0,
    ),
  };
}
