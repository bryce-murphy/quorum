import type { ClaimResult, Ledger, Tier } from "@quorum/contracts";
import { SCHEMA_IDS, tierRank } from "@quorum/contracts";
import type { LedgerContext } from "../types.js";

/**
 * Fail-closed / fail-open verdict (SPEC §5):
 *  - salvage mode is advisory: it reports but never blocks → always pass.
 *  - strict mode: any `failed` claim blocks; `unverifiable_disclosed` blocks at
 *    T2+ (fail-closed for risky work) but passes at T0/T1 (fail-open for trivia).
 */
export function computeVerdict(
  results: readonly ClaimResult[],
  mode: "strict" | "salvage",
  tier: Tier,
): "pass" | "fail" {
  if (mode === "salvage") return "pass";
  if (results.some((r) => r.status === "failed")) return "fail";
  const disclosedBlocks = tierRank(tier) >= tierRank("T2");
  if (disclosedBlocks && results.some((r) => r.status === "unverifiable_disclosed")) {
    return "fail";
  }
  return "pass";
}

/** Assemble the ledger of record from per-claim results (SPEC §3.4). */
export function buildLedger(results: readonly ClaimResult[], ctx: LedgerContext): Ledger {
  const counts = {
    total: results.length,
    verified: results.filter((r) => r.status === "verified").length,
    failed: results.filter((r) => r.status === "failed").length,
    unverifiable_disclosed: results.filter((r) => r.status === "unverifiable_disclosed").length,
  };
  return {
    schema: SCHEMA_IDS.ledger,
    task: ctx.task,
    head: ctx.head,
    mode: ctx.mode,
    results: [...results],
    counts,
    tier_effective: ctx.tier_effective,
    verdict: computeVerdict(results, ctx.mode, ctx.tier_effective),
  };
}
