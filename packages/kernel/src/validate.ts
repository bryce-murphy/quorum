import { SCHEMA_REGISTRY } from "@quorum/contracts";

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate a parsed JSON artifact against a registered schema id. Routes through
 * the same zod schemas the JSON Schema is generated from, so CLI validation and
 * the generated contract never diverge.
 */
export function validateArtifact(json: unknown, schemaId: string): ValidateResult {
  const entry = SCHEMA_REGISTRY[schemaId];
  if (!entry) {
    return { ok: false, errors: [`unknown schema id: ${schemaId}`] };
  }
  const parsed = entry.schema.safeParse(json);
  if (parsed.success) return { ok: true };
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}
