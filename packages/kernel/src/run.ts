import type { Claim, ClaimResult } from "@quorum/contracts";
import type { ForgeAdapter } from "./forge/adapter.js";
import type { VerifyContext } from "./types.js";
import { verifyClaim } from "./verify/index.js";

/** Verify a batch of claims in order. Deterministic: no concurrency, so evidence
 *  ordering is stable for the ledger. */
export async function verifyClaims(
  claims: readonly Claim[],
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];
  for (const claim of claims) {
    results.push(await verifyClaim(claim, forge, ctx));
  }
  return results;
}
