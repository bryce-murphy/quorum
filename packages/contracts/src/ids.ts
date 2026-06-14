/** Canonical schema identifiers. Every artifact carries its `schema` field so the
 *  kernel can dispatch validation deterministically (principle 6: machine-first). */
export const SCHEMA_IDS = {
  claim: "quorum.claim/v1",
  ledger: "quorum.ledger/v1",
  task: "quorum.task/v1",
  policy: "quorum.policy/v1",
} as const;

export type SchemaId = (typeof SCHEMA_IDS)[keyof typeof SCHEMA_IDS];
