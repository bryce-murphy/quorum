import { describe, it, expect } from "vitest";
import type { Claim, ClaimResult, Policy, PolicyRule } from "@quorum/contracts";
import { MemoryForge } from "../src/forge/memory.js";
import { resolveReferencedFloors, ReferenceResolutionError } from "../src/references/resolve.js";
import { computeTierFloor } from "../src/tier/floor.js";
import { computeUncoveredPaths } from "../src/gate.js";
import {
  referencedFloor,
  isReferencedPath,
  EMPTY_REFERENCED_FLOORS,
} from "../src/tier/references.js";
import type { DiffEntry } from "../src/diff.js";
import { mkClaim } from "./fixtures/amas.js";

const entry = (path: string): DiffEntry => ({ status: "M", oldMode: "100644", newMode: "100644", path });
const resultFor = (claim: Claim, status: ClaimResult["status"]): ClaimResult => ({
  claim_id: claim.id,
  type: claim.type,
  status,
  evidence: {},
});

function policyWith(rules: PolicyRule[], extra: Partial<Policy> = {}): Policy {
  return { schema: "quorum.policy/v1", default_floor: "T0", rules, ...extra };
}

const CLAUDE_RULE: PolicyRule = { glob: "**/CLAUDE.md", floor: "T3", reference_extractor: "claude-md" };
const OPENCODE_RULE: PolicyRule = {
  glob: "**/opencode.json",
  floor: "T3",
  reference_extractor: "opencode-json",
};

async function resolve(files: Record<string, string>, rules: PolicyRule[]) {
  return resolveReferencedFloors(policyWith(rules), new MemoryForge({ files: { R: files } }), "R");
}

describe("QRM-3.4 resolveReferencedFloors (through the resolver)", () => {
  it("enumerates **/opencode.json configs and folds exact + glob + agent-prompt", async () => {
    const rf = await resolve(
      {
        "opencode.json": JSON.stringify({
          instructions: ["guides/setup.md", "guides/**/*.md"],
          agent: { review: { prompt: "{file:prompts/review.md}" } },
        }),
      },
      [OPENCODE_RULE],
    );
    expect(referencedFloor("guides/setup.md", rf)).toBe("T3");
    expect(referencedFloor("guides/deep/x.md", rf)).toBe("T3"); // via glob
    expect(referencedFloor("prompts/review.md", rf)).toBe("T3"); // via {file:}
  });

  it("resolves multiple extractor rules at once (claude-md + opencode-json)", async () => {
    const rf = await resolve(
      {
        "CLAUDE.md": "@memory/x.md",
        "opencode.json": JSON.stringify({ instructions: ["oc/y.md"] }),
      },
      [CLAUDE_RULE, OPENCODE_RULE],
    );
    expect(referencedFloor("memory/x.md", rf)).toBe("T3");
    expect(referencedFloor("oc/y.md", rf)).toBe("T3");
  });

  it("a case-variant changed path floors via case-fold", async () => {
    const rf = await resolve({ "CLAUDE.md": "@Docs/Setup.md" }, [CLAUDE_RULE]);
    // stored key is lower-cased; a differently-cased changed path still matches.
    expect(referencedFloor("docs/setup.md", rf)).toBe("T3");
    expect(referencedFloor("DOCS/SETUP.md", rf)).toBe("T3");
  });

  it("fails closed when a reference-bearing rule exists but the tree cannot be listed", async () => {
    const forge = new MemoryForge({ files: { R: { "CLAUDE.md": "@x.md" } }, unsupported: ["listFiles"] });
    await expect(resolveReferencedFloors(policyWith([CLAUDE_RULE]), forge, "R")).rejects.toBeInstanceOf(
      ReferenceResolutionError,
    );
  });

  it("returns the empty set (no throw) when no rule bears an extractor", async () => {
    const forge = new MemoryForge({ files: { R: {} }, unsupported: ["listFiles"] });
    const rf = await resolveReferencedFloors(
      policyWith([{ glob: "schemas/**", floor: "T3" }]),
      forge,
      "R",
    );
    expect(rf.exact.size).toBe(0);
    expect(rf.globs.length).toBe(0);
  });
});

describe("QRM-3.4 computeTierFloor reference contribution", () => {
  it("floors a changed path that is ONLY referenced (no static glob matches it)", async () => {
    const rf = await resolve({ "CLAUDE.md": "@memory/notes.md" }, [CLAUDE_RULE]);
    const policy = policyWith([CLAUDE_RULE]);
    // memory/notes.md matches no path glob; the floor comes purely from the reference.
    expect(computeTierFloor([entry("memory/notes.md")], policy, rf)).toBe("T3");
  });

  it("2-arg computeTierFloor is unchanged (backward compat)", async () => {
    const rf = await resolve({ "CLAUDE.md": "@memory/notes.md" }, [CLAUDE_RULE]);
    const policy = policyWith([CLAUDE_RULE]);
    // Without referencedFloors the referenced-only path is NOT floored (T0).
    expect(computeTierFloor([entry("memory/notes.md")], policy)).toBe("T0");
    // ...and passing an explicit empty set is likewise T0.
    expect(computeTierFloor([entry("memory/notes.md")], policy, EMPTY_REFERENCED_FLOORS)).toBe("T0");
  });

  it("preserves the QRM-3.1 mode floor alongside references", async () => {
    const rf = await resolve({ "CLAUDE.md": "@memory/notes.md" }, [CLAUDE_RULE]);
    const policy = policyWith([CLAUDE_RULE]);
    const symlink: DiffEntry = { status: "A", oldMode: "000000", newMode: "120000", path: "weird/link" };
    // The symlink floors T3 by mode even though no reference/glob matches its path.
    expect(computeTierFloor([symlink], policy, rf)).toBe("T3");
  });

  it("leaves plain (non-reference) rules unaffected", async () => {
    const rf = await resolve({ "CLAUDE.md": "@memory/notes.md" }, [CLAUDE_RULE]);
    const policy = policyWith([CLAUDE_RULE]);
    expect(computeTierFloor([entry("src/ordinary.ts")], policy, rf)).toBe("T0");
  });
});

describe("QRM-3.4 coverage sibling-hole override", () => {
  it("a referenced path is UNCOVERED even when it matches an exempt glob", async () => {
    const rf = await resolve({ "CLAUDE.md": "@gen/notes.md" }, [CLAUDE_RULE]);
    const app = mkClaim({ type: "file_created", subject: { path: "src/app.ts" } });
    const uncovered = computeUncoveredPaths(
      [app],
      [resultFor(app, "verified")],
      ["src/app.ts", "gen/notes.md"],
      ["gen/**"], // would normally exempt gen/notes.md
      "T3",
      rf,
    );
    expect(uncovered).toEqual(["gen/notes.md"]);
  });

  it("a NON-referenced path in the same exempt glob stays covered (no over-reach)", async () => {
    const rf = await resolve({ "CLAUDE.md": "@gen/notes.md" }, [CLAUDE_RULE]);
    const app = mkClaim({ type: "file_created", subject: { path: "src/app.ts" } });
    const uncovered = computeUncoveredPaths(
      [app],
      [resultFor(app, "verified")],
      ["src/app.ts", "gen/other.js"], // gen/other.js is NOT referenced
      ["gen/**"],
      "T3",
      rf,
    );
    expect(uncovered).toEqual([]);
  });

  it("without referencedFloors, exempt paths behave exactly as before (backward compat)", () => {
    const app = mkClaim({ type: "file_created", subject: { path: "src/app.ts" } });
    const uncovered = computeUncoveredPaths(
      [app],
      [resultFor(app, "verified")],
      ["src/app.ts", "gen/notes.md"],
      ["gen/**"],
      "T3",
    );
    expect(uncovered).toEqual([]);
  });
});

describe("QRM-3.4 isReferencedPath / referencedFloor matcher parity", () => {
  it("isReferencedPath agrees with referencedFloor across exact and glob", async () => {
    const rf = await resolve(
      { "opencode.json": JSON.stringify({ instructions: ["exact/a.md", "globbed/**/*.md"] }) },
      [OPENCODE_RULE],
    );
    for (const p of ["exact/a.md", "globbed/deep/b.md"]) {
      expect(isReferencedPath(p, rf)).toBe(true);
      expect(referencedFloor(p, rf)).toBe("T3");
    }
    expect(isReferencedPath("unrelated/c.md", rf)).toBe(false);
    expect(referencedFloor("unrelated/c.md", rf)).toBeUndefined();
  });
});
