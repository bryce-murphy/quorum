import { z } from "zod";
import { SCHEMA_IDS } from "./ids.js";
import { TierSchema } from "./tier.js";

/** A path-based tier-floor rule (SPEC 1.2). First-listed-wins is *not* assumed;
 *  the kernel takes the max floor over all matching rules. */
export const PolicyRuleSchema = z
  .object({
    glob: z.string().min(1),
    floor: TierSchema,
    // QRM-3.4: an optional extractor that resolves DELEGATED references from a
    // floored agent-config to in-repo files (so editing only a referenced file
    // grades at the config's floor, not the default). A STRICT enum: an unknown
    // value schema-fails (fail closed). The policy stays the auditable trust
    // surface. Absent => the rule floors its own paths only (no reference
    // resolution). v1 extractors: `claude-md` (@import), `opencode-json`
    // (instructions[] + instruction-field {file:}).
    reference_extractor: z.enum(["claude-md", "opencode-json"]).optional(),
  })
  .strict();

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z
  .object({
    schema: z.literal(SCHEMA_IDS.policy),
    // Floor applied when no rule matches (SPEC 1.2: "everything else -> T0").
    default_floor: TierSchema,
    rules: z.array(PolicyRuleSchema),
    // Globs for changed paths that need no covering claim (e.g. generated
    // output). Diff-coverage (FIX 1) treats a path matching any of these as
    // covered. Optional; defaults to none.
    exempt_paths: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
