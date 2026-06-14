import { z } from "zod";
import { SCHEMA_IDS } from "./ids.js";
import { ClaimTypeSchema } from "./claim.js";
import { TierSchema } from "./tier.js";

/** A claim's verdict (SPEC 3.1):
 *  - verified               - checked against actual state, content matched
 *  - verified_exists        - file present/changed as claimed, but content was
 *                             NOT hash-verified (no expected.sha256). Honest
 *                             weaker label: existence only, content unverified.
 *  - failed                 - checked, does not match (fabrication / drift)
 *  - unverifiable_disclosed - agent honestly declared it could not verify */
export const CLAIM_STATUSES = [
  "verified",
  "verified_exists",
  "failed",
  "unverifiable_disclosed",
] as const;
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);

export const ModeSchema = z.enum(["strict", "salvage"]);
export const VerdictSchema = z.enum(["pass", "fail"]);

export const ClaimResultSchema = z
  .object({
    claim_id: z.string(),
    type: ClaimTypeSchema,
    status: ClaimStatusSchema,
    // Free-form, deterministic provenance: resolved hashes, API record ids,
    // content-match flags. Preserves e.g. Sub-shape B's "finding is still real".
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ClaimResult = z.infer<typeof ClaimResultSchema>;

export const LedgerSchema = z
  .object({
    schema: z.literal(SCHEMA_IDS.ledger),
    task: z.string(),
    head: z.string(),
    mode: ModeSchema,
    results: z.array(ClaimResultSchema),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        verified: z.number().int().nonnegative(),
        verified_exists: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        unverifiable_disclosed: z.number().int().nonnegative(),
      })
      .strict(),
    // Changed paths (mergeBase..head) not covered by any verified/verified_exists
    // file claim or policy exemption. Non-empty => the change is under-verified
    // and the Gate blocks in strict mode (FIX 1, diff-coverage requirement).
    uncovered_paths: z.array(z.string()),
    tier_effective: TierSchema,
    verdict: VerdictSchema,
  })
  .strict();

export type Ledger = z.infer<typeof LedgerSchema>;
