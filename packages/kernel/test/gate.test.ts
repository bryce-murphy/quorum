import { describe, it, expect } from "vitest";
import type { Claim, ClaimResult } from "@quorum/contracts";
import { applyStrictFailClosed, computeUncoveredPaths } from "../src/gate.js";
import { mkClaim } from "./fixtures/amas.js";

const resultFor = (claim: Claim, status: ClaimResult["status"]): ClaimResult => ({
  claim_id: claim.id,
  type: claim.type,
  status,
  evidence: {},
});

// FIX 1 - the verifier must verify the CHANGE, not just the claims that exist.
describe("computeUncoveredPaths (diff coverage)", () => {
  it("flags an unclaimed changed path (the backdoor case)", () => {
    const app = mkClaim({ type: "file_created", subject: { path: "src/app.ts" } });
    const uncovered = computeUncoveredPaths(
      [app],
      [resultFor(app, "verified_exists")],
      ["src/app.ts", "src/backdoor.ts"],
    );
    expect(uncovered).toEqual(["src/backdoor.ts"]);
  });

  it("a failed claim does NOT cover its path", () => {
    const x = mkClaim({ type: "file_created", subject: { path: "src/x.ts" } });
    const uncovered = computeUncoveredPaths([x], [resultFor(x, "failed")], ["src/x.ts"]);
    expect(uncovered).toEqual(["src/x.ts"]);
  });

  it("verified and verified_exists both cover", () => {
    const a = mkClaim({ type: "file_created", subject: { path: "a.ts" } });
    const b = mkClaim({ type: "file_modified", subject: { path: "b.ts" } });
    const uncovered = computeUncoveredPaths(
      [a, b],
      [resultFor(a, "verified"), resultFor(b, "verified_exists")],
      ["a.ts", "b.ts"],
    );
    expect(uncovered).toEqual([]);
  });

  it("policy exemptions cover generated paths", () => {
    const app = mkClaim({ type: "file_created", subject: { path: "src/app.ts" } });
    const uncovered = computeUncoveredPaths(
      [app],
      [resultFor(app, "verified")],
      ["src/app.ts", "dist/bundle.js", "gen/types.d.ts"],
      ["dist/**", "gen/**"],
    );
    expect(uncovered).toEqual([]);
  });

  it("normalizes path spellings so coverage cannot be evaded", () => {
    const app = mkClaim({ type: "file_created", subject: { path: "src/app.ts" } });
    // claim path and changed path differ only in spelling.
    const uncovered = computeUncoveredPaths([app], [resultFor(app, "verified")], ["./src/app.ts"]);
    expect(uncovered).toEqual([]);
  });
});

// FIX 4 - forge-only claims fail closed in strict mode at all tiers.
describe("applyStrictFailClosed", () => {
  it("reclassifies an unverifiable forge-only claim to failed in strict", () => {
    const tp = mkClaim({ type: "test_passed", subject: { check_name: "ci" } });
    const [out] = applyStrictFailClosed([resultFor(tp, "unverifiable_disclosed")], "strict");
    expect(out?.status).toBe("failed");
    expect(out?.evidence["fail_closed"]).toBe(true);
  });

  it("leaves a file-claim disclosure honest (not forge-only)", () => {
    const fc = mkClaim({ type: "file_created", subject: { path: "a.ts" } });
    const [out] = applyStrictFailClosed([resultFor(fc, "unverifiable_disclosed")], "strict");
    expect(out?.status).toBe("unverifiable_disclosed");
  });

  it("does nothing in salvage mode", () => {
    const tp = mkClaim({ type: "review_posted", subject: { pr: 1 } });
    const [out] = applyStrictFailClosed([resultFor(tp, "unverifiable_disclosed")], "salvage");
    expect(out?.status).toBe("unverifiable_disclosed");
  });
});
