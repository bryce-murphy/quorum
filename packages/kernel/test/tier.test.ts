import { describe, it, expect } from "vitest";
import type { Policy } from "@quorum/contracts";
import { computeTierFloor } from "../src/tier/floor.js";
import type { DiffEntry } from "../src/diff.js";
import { globMatches, normalizePath, PathNormalizationError } from "../src/tier/glob.js";

/** Ordinary (regular-file, mode 100644) changed entries for these path-glob
 *  tests - the mode floor is exercised separately in mode-floor.test.ts. */
const E = (...paths: string[]): DiffEntry[] =>
  paths.map((path) => ({ status: "M", oldMode: "100644", newMode: "100644", path }));

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
    expect(computeTierFloor(E("src/app.ts", "README.md"), policy)).toBe("T0");
  });

  it("raises to T3 for enforcement-machinery paths (schemas/**)", () => {
    expect(computeTierFloor(E("src/app.ts", "schemas/claim.schema.json"), policy)).toBe("T3");
  });

  it("raises to T3 for workflow + lockfile changes", () => {
    expect(computeTierFloor(E(".github/workflows/ci.yml"), policy)).toBe("T3");
    expect(computeTierFloor(E("package-lock.json"), policy)).toBe("T3");
  });

  it("takes the max over many paths", () => {
    expect(computeTierFloor(E("docs/x.md", "schemas/policy.schema.json", "src/y.ts"), policy)).toBe("T3");
  });
});

// FIX A - the floor is a security control: equivalent path spellings must not
// evade a rule, and hostile paths are a hard error, never a default-floor pass.
describe("normalizePath", () => {
  it("canonicalizes separators, leading ./, and doubled slashes", () => {
    expect(normalizePath(".\\schemas\\claim.schema.json")).toBe("schemas/claim.schema.json");
    expect(normalizePath("./.github/workflows/deploy.yml")).toBe(".github/workflows/deploy.yml");
    expect(normalizePath("schemas//a///b.json")).toBe("schemas/a/b.json");
    expect(normalizePath("././src/a.ts")).toBe("src/a.ts");
  });

  it("hard-rejects absolute paths, traversal, and NUL bytes", () => {
    for (const bad of [
      "/etc/passwd",
      "C:\\Windows\\system32",
      "C:/Windows/system32",
      "\\\\server\\share\\x",
      "../../etc/passwd",
      "schemas/../../../etc/passwd",
      `schemas/${String.fromCharCode(0)}x.json`,
    ]) {
      expect(() => normalizePath(bad)).toThrow(PathNormalizationError);
    }
  });
});

describe("computeTierFloor - floor-evasion resistance (FIX A)", () => {
  it("resolves equivalent spellings of enforcement paths to T3", () => {
    for (const path of [
      "./.github/workflows/deploy.yml",
      ".\\schemas\\claim.schema.json",
      "packages//gate-action///run.ts",
      "deep/nested/dir/package-lock.json",
    ]) {
      expect(computeTierFloor(E(path), policy)).toBe("T3");
    }
  });

  it("matches case-insensitively so case is not an evasion vector", () => {
    expect(computeTierFloor(E(".GitHub/Workflows/Deploy.yml"), policy)).toBe("T3");
    expect(computeTierFloor(E("Schemas/Claim.Schema.json"), policy)).toBe("T3");
  });

  it("throws (does not silently fall through) on a traversal path", () => {
    expect(() => computeTierFloor(E("../../etc/passwd"), policy)).toThrow(PathNormalizationError);
  });
});
