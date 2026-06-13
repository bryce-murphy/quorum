import { z } from "zod";
import { SCHEMA_IDS } from "./ids.js";
import { TierSchema } from "./tier.js";

/** A path-based tier-floor rule (SPEC 1.2). First-listed-wins is *not* assumed;
 *  the kernel takes the max floor over all matching rules. */
export const PolicyRuleSchema = z
  .object({
    glob: z.string().min(1),
    floor: TierSchema,
  })
  .strict();

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z
  .object({
    schema: z.literal(SCHEMA_IDS.policy),
    // Floor applied when no rule matches (SPEC 1.2: "everything else -> T0").
    default_floor: TierSchema,
    rules: z.array(PolicyRuleSchema),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
