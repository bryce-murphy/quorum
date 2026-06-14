import { zodToJsonSchema } from "zod-to-json-schema";
import { SCHEMA_REGISTRY } from "./registry.js";

/** Generate the JSON Schema for every registered contract, keyed by file stem.
 *  `$refStrategy: "none"` inlines all subschemas so output is self-contained and
 *  order-independent - a precondition for the byte-stable drift check. */
export function generateSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of Object.values(SCHEMA_REGISTRY)) {
    out[entry.file] = zodToJsonSchema(entry.schema, {
      name: entry.name,
      $refStrategy: "none",
      target: "jsonSchema7",
    });
  }
  return out;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic serialization: recursively key-sorted, 2-space, trailing newline.
 *  Identical input -> identical bytes on every machine (paired with .gitattributes
 *  eol=lf), which is what makes the drift test meaningful. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
