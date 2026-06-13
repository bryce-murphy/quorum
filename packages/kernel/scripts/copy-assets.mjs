// Copy non-TS runtime data into dist so the built CLI can read it. tsc does not
// copy .json data files, and the salvage miner loads patterns.json relative to
// its own module location (which is dist/extract at runtime).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(pkgRoot, "dist/extract"), { recursive: true });
copyFileSync(
  join(pkgRoot, "src/extract/patterns.json"),
  join(pkgRoot, "dist/extract/patterns.json"),
);
