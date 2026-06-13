import { describe, it, expect } from "vitest";
import type { Policy } from "@quorum/contracts";
import { computeTierFloor } from "../src/tier/floor.js";
import { globMatches } from "../src/tier/glob.js";

describe("globMatches", () => {
  it("** crosses directory separators", () => {
    expect(globMatches(".github/workflows/**", ".github/workflows/ci.yml")).toBe(true);
    expect(globMatches("schemas/**", "schemas/claim.schema.json")).toBe(true);
  });

  it("**/ matches zero or more leading directories", () => {
    expect(globMatches("**/package-lock.json", "package-lock.json")).toBe(true);
    expect(globMatches("**/package-lock.json", "packages/a/package-lock.json")).toBe(true);
  });

  it("* stays within a path segment", () => {
    expect(globMatches("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/nested/a.ts")).toBe(false);
  });

  it("exact path rule", () => {
    expect(globMatches(".quorum/policy.json", ".quorum/policy.json")).toBe(true);
    expect(globMatches(".quorum/policy.json", ".quorum/other.json")).toBe(false);
  });
});

const policy: Policy = {
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [
    { glob: ".github/workflows/**", floor: "T3" },
    { glob: "schemas/**", floor: "T3" },
    { glob: ".quorum/policy.json", floor: "T3" },
    { glob: "packages/gate-action/**", floor: "T3" },
    { glob: "**/package-lock.json", floor: "T3" },
  ],
};

describe("computeTierFloor", () => {
  it("returns default floor when nothing matches", () => {
    expect(computeTierFloor(["src/app.ts", "README.md"], policy)).toBe("T0");
  });

  it("raises to T3 for enforcement-machinery paths (schemas/**)", () => {
    expect(computeTierFloor(["src/app.ts", "schemas/claim.schema.json"], policy)).toBe("T3");
  });

  it("raises to T3 for workflow + lockfile changes", () => {
    expect(computeTierFloor([".github/workflows/ci.yml"], policy)).toBe("T3");
    expect(computeTierFloor(["package-lock.json"], policy)).toBe("T3");
  });

  it("takes the max over many paths", () => {
    expect(computeTierFloor(["docs/x.md", "schemas/policy.schema.json", "src/y.ts"], policy)).toBe("T3");
  });
});
