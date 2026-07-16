import { describe, it, expect } from "vitest";
import { MemoryForge } from "../src/forge/memory.js";
import { TreeParseError } from "../src/forge/tree-diff.js";

// QRM-4.0-branch-freshness [2] fix delta (Codex NIT - false adapter contract).
// ForgeAdapter.resolveRefCommit promises a CERTIFIED full-lowercase-40-hex commit
// identity (design §3.1), and both GitHubForge and LocalGitForge enforce it by
// construction (throwing the forge-layer TreeParseError on malformed first-party
// data). MemoryForge previously returned its `refs` fixture bytes UNCHECKED, so a
// non-40-hex fixture value would silently seed an uncertified SHA into a freshness
// equality the fixture corpus is meant to exercise honestly. These pins prove the
// contract now holds symmetrically across all three adapters.
describe("MemoryForge.resolveRefCommit - certified fixture tip (ForgeAdapter contract, §3.1)", () => {
  it("returns the certified sha wrapped in 'ok' for a well-formed 40-hex fixture", async () => {
    const sha = "a".repeat(40);
    const forge = new MemoryForge({ refs: { main: sha } });
    expect(await forge.resolveRefCommit("main")).toEqual({ kind: "ok", value: sha });
  });

  it("returns absent for a ref absent from the fixture map (absence is never freshness)", async () => {
    const forge = new MemoryForge({ refs: {} });
    expect((await forge.resolveRefCommit("nope")).kind).toBe("absent");
  });

  it("returns unsupported when the method is listed in the off-ramp set", async () => {
    const forge = new MemoryForge({ refs: { main: "a".repeat(40) }, unsupported: ["resolveRefCommit"] });
    expect((await forge.resolveRefCommit("main")).kind).toBe("unsupported");
  });

  // A non-40-hex fixture value must THROW (TreeParseError), never return `ok` - the
  // same regex GitHubForge/LocalGitForge apply. Each case would have passed straight
  // through as `ok` before the fix.
  const malformed: Record<string, string> = {
    short: "abc123",
    "uppercase-40": "A".repeat(40),
    "wrong-length (41)": "a".repeat(41),
    "wrong-length (39)": "a".repeat(39),
    "non-hex": "g".repeat(40),
    "branch-like": "refs/heads/main",
    empty: "",
  };
  for (const [label, sha] of Object.entries(malformed)) {
    it(`throws TreeParseError (not ok) on a non-40-hex fixture value: ${label}`, async () => {
      const forge = new MemoryForge({ refs: { main: sha } });
      await expect(forge.resolveRefCommit("main")).rejects.toBeInstanceOf(TreeParseError);
    });
  }
});
