import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateSchemas, stableStringify } from "../src/json-schema.js";

// M1 acceptance (SPEC §6): generated JSON Schema must match the committed files
// byte-for-byte. If a zod schema changes without regenerating, this fails — the
// schemas are the parse target, so drift is a defect, not a nuisance.
describe("schema drift", () => {
  const schemas = generateSchemas();

  for (const [file, schema] of Object.entries(schemas)) {
    it(`${file}.schema.json is in sync with its zod source`, () => {
      const committedPath = fileURLToPath(
        new URL(`../schemas/${file}.schema.json`, import.meta.url),
      );
      const committed = readFileSync(committedPath, "utf8");
      expect(stableStringify(schema)).toBe(committed);
    });
  }
});
