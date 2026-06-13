import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSchemas, stableStringify } from "../json-schema.js";

// Run via `npm run gen:schemas -w @quorum/contracts`, which sets cwd to the
// package root, so `schemas/` resolves to the committed source directory.
const outDir = join(process.cwd(), "schemas");
mkdirSync(outDir, { recursive: true });

for (const [file, schema] of Object.entries(generateSchemas())) {
  const path = join(outDir, `${file}.schema.json`);
  writeFileSync(path, stableStringify(schema));
  process.stdout.write(`wrote ${path}\n`);
}
