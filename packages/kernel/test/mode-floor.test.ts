import { describe, it, expect } from "vitest";
import type { Policy } from "@quorum/contracts";
import { computeTierFloor } from "../src/tier/floor.js";
import type { DiffEntry } from "../src/diff.js";

// A deliberately MINIMAL policy: default T0, one unrelated path rule. None of its
// globs match the symlink/gitlink paths below, so any T3 result here is the MODE
// floor doing the work - not a path glob. This is the QRM-3.0 red-team R2/R3
// residual: an indirection at an arbitrary path a glob cannot enumerate.
const policy: Policy = {
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "schemas/**", floor: "T3" }],
};

const e = (over: Partial<DiffEntry> & { path: string }): DiffEntry => ({
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  ...over,
});

describe("computeTierFloor - mode floor (QRM-3.1)", () => {
  it("ordinary files at an unmatched path stay at the default floor", () => {
    expect(computeTierFloor([e({ path: "packages/app/main.ts" })], policy)).toBe("T0");
  });

  it("floors a symlink (newMode 120000) to T3 unconditionally", () => {
    expect(computeTierFloor([e({ path: "some/where/link", status: "T", newMode: "120000" })], policy)).toBe("T3");
  });

  it("floors a gitlink/submodule (newMode 160000) to T3 unconditionally", () => {
    expect(computeTierFloor([e({ path: "vendor/dep", status: "A", oldMode: "000000", newMode: "160000" })], policy)).toBe("T3");
  });

  // The core repro (matrix #9): a symlink at an arbitrary path that NO path glob
  // matches - here packages/app/.codex - still floors to T3. Under the minimal
  // policy nothing path-matches, so this proves the mode is what triggers.
  it("floors an arbitrary-path symlink (packages/app/.codex) to T3 with no matching glob", () => {
    const entries = [e({ path: "packages/app/.codex", status: "A", oldMode: "000000", newMode: "120000" })];
    expect(computeTierFloor(entries, policy)).toBe("T3");
  });

  it("does NOT floor symlink -> regular-file (newMode 100644, oldMode 120000)", () => {
    expect(computeTierFloor([e({ path: "was-link", status: "T", oldMode: "120000", newMode: "100644" })], policy)).toBe("T0");
  });

  it("does NOT floor a deleted symlink (newMode 000000)", () => {
    expect(computeTierFloor([e({ path: "old-link", status: "D", oldMode: "120000", newMode: "000000" })], policy)).toBe("T0");
  });

  it("floors a rename whose destination mode becomes a symlink (both paths surfaced)", () => {
    const entries = [e({ status: "R087", oldMode: "100644", newMode: "120000", oldPath: "a/real.txt", path: "b/link" })];
    expect(computeTierFloor(entries, policy)).toBe("T3");
  });

  it("combines mode floor and glob floor by max (both contribute T3)", () => {
    const entries = [
      e({ path: "schemas/x.json" }), // glob -> T3
      e({ path: "anywhere/link", status: "T", newMode: "120000" }), // mode -> T3
    ];
    expect(computeTierFloor(entries, policy)).toBe("T3");
  });

  it("mode floor wins even when every changed path is glob-unmatched and at default", () => {
    const entries = [
      e({ path: "README.md" }),
      e({ path: "deep/nested/thing", status: "T", newMode: "160000" }),
    ];
    expect(computeTierFloor(entries, policy)).toBe("T3");
  });
});
