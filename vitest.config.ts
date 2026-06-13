import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve @quorum/contracts to its TypeScript source so the suite runs without a
// prior build. The published resolution (dist) is exercised separately by the CLI
// acceptance check, which runs from compiled output.
const contractsSrc = fileURLToPath(
  new URL("./packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@quorum/contracts": contractsSrc,
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
  },
});
