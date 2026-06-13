import { z } from "zod";

/** Risk tiers T0-T4 (SPEC 1.2). Ordered low->high blast radius. */
export const TIERS = ["T0", "T1", "T2", "T3", "T4"] as const;
export type Tier = (typeof TIERS)[number];

export const TierSchema = z.enum(TIERS);

/** Position of a tier in the ordering (T0 = 0 ... T4 = 4). */
export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** The higher (more restrictive) of two tiers. The Gate takes max(proposed, floor)
 *  so a high-blast-radius diff can never be re-graded downward (SPEC 1.2). */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}
