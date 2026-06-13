import { z } from "zod";
import { SCHEMA_IDS } from "./ids.js";
import { TierSchema } from "./tier.js";

/** Phase 1 task state machine (SPEC §3.3): deliberately minimal.
 *  Review/red-team states arrive in Phase 2 with the agents. */
export const TASK_STATES = [
  "planned",
  "in_progress",
  "handed_back",
  "verified",
  "merged",
  "blocked",
] as const;
export const TaskStateSchema = z.enum(TASK_STATES);

export const TaskManifestSchema = z
  .object({
    schema: z.literal(SCHEMA_IDS.task),
    id: z.string().min(1),
    title: z.string().min(1),
    tier_proposed: TierSchema,
    // Written by the Gate as max(proposed, floor); null until computed.
    tier_effective: TierSchema.nullable(),
    acceptance: z.array(z.string().min(1)),
    branch: z.string().min(1),
    state: TaskStateSchema,
    // role id → model id, e.g. { "builder": "claude-opus-4-8" }
    agents: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export type TaskManifest = z.infer<typeof TaskManifestSchema>;
