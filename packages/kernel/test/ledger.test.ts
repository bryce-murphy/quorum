import { describe, it, expect } from "vitest";
import type { ClaimResult } from "@quorum/contracts";
import { buildLedger, computeVerdict } from "../src/ledger/build.js";
import { renderHeadline } from "../src/ledger/render.js";

const result = (status: ClaimResult["status"]): ClaimResult => ({
  claim_id: "clm_000000000001",
  type: "file_created",
  status,
  evidence: {},
});

describe("computeVerdict", () => {
  it("fails in strict mode on any failed claim", () => {
    expect(computeVerdict([result("verified"), result("failed")], "strict", "T1", [], true)).toBe("fail");
  });

  it("disclosed-unverifiable passes at T0/T1 but fails at T2+ (strict)", () => {
    // covering claim present + diff covered, so only the disclosed rule is exercised.
    const rs = [result("verified"), result("unverifiable_disclosed")];
    expect(computeVerdict(rs, "strict", "T1", [], true)).toBe("pass");
    expect(computeVerdict(rs, "strict", "T2", [], true)).toBe("fail");
    expect(computeVerdict(rs, "strict", "T3", [], true)).toBe("fail");
  });

  it("salvage mode is advisory and always passes", () => {
    expect(computeVerdict([result("failed")], "salvage", "T3", ["x"], true)).toBe("pass");
  });

  // FIX 1 — diff-coverage requirement.
  it("blocks a non-empty diff with zero covering claims at all tiers", () => {
    expect(computeVerdict([], "strict", "T0", [], true)).toBe("fail");
    expect(computeVerdict([result("unverifiable_disclosed")], "strict", "T1", ["a.ts"], true)).toBe("fail");
  });

  it("blocks ANY uncovered changed path in strict mode, at every tier", () => {
    const rs = [result("verified")];
    expect(computeVerdict(rs, "strict", "T0", ["uncovered.ts"], true)).toBe("fail");
    expect(computeVerdict(rs, "strict", "T1", ["uncovered.ts"], true)).toBe("fail");
    expect(computeVerdict(rs, "strict", "T3", ["uncovered.ts"], true)).toBe("fail");
    // fully covered -> clear
    expect(computeVerdict(rs, "strict", "T3", [], true)).toBe("pass");
  });

  it("verified_exists is a passing, covering status", () => {
    expect(computeVerdict([result("verified_exists")], "strict", "T3", [], true)).toBe("pass");
  });
});

describe("renderHeadline", () => {
  it("renders the SPEC 3.4 one-liner", () => {
    const results = [
      ...Array.from({ length: 12 }, () => result("verified")),
      result("unverifiable_disclosed"),
      result("failed"),
    ];
    const ledger = buildLedger(results, {
      task: "QRM-9",
      head: "abc123",
      mode: "strict",
      tier_effective: "T2",
    });
    expect(renderHeadline(ledger)).toBe(
      "Quorum: 14 claims - 12 verified · 1 disclosed-unverifiable · 1 FAILED → blocking (T2, strict)",
    );
  });

  it("renders a clean ledger when everything verifies", () => {
    const ledger = buildLedger([result("verified")], {
      task: "QRM-9",
      head: "abc123",
      mode: "strict",
      tier_effective: "T1",
    });
    expect(renderHeadline(ledger)).toBe("Quorum: 1 claims - 1 verified → clear (T1, strict)");
  });
});
