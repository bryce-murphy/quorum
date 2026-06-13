import type { ZodTypeAny } from "zod";
import { SCHEMA_IDS } from "./ids.js";
import { ClaimSchema } from "./claim.js";
import { LedgerSchema } from "./ledger.js";
import { TaskManifestSchema } from "./task-manifest.js";
import { PolicySchema } from "./policy.js";

export interface SchemaEntry {
  /** Title embedded in the generated JSON Schema. */
  readonly name: string;
  /** Output filename stem: `<file>.schema.json`. */
  readonly file: string;
  readonly schema: ZodTypeAny;
}

/** Single source of truth tying schema ids → zod schemas → generated files.
 *  Reused by the JSON Schema generator, the drift test, and the kernel's
 *  `validateArtifact` so nothing can fall out of sync. */
export const SCHEMA_REGISTRY: Record<string, SchemaEntry> = {
  [SCHEMA_IDS.claim]: { name: "Claim", file: "claim", schema: ClaimSchema },
  [SCHEMA_IDS.ledger]: { name: "Ledger", file: "ledger", schema: LedgerSchema },
  [SCHEMA_IDS.task]: { name: "TaskManifest", file: "task-manifest", schema: TaskManifestSchema },
  [SCHEMA_IDS.policy]: { name: "Policy", file: "policy", schema: PolicySchema },
};
