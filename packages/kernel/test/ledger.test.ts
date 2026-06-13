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
    expect(computeVerdict([result("verified"), result("failed")], "strict", "T1")).toBe("fail");
  });

  it("disclosed-unverifiable passes at T0/T1 but fails at T2+ (strict)", () => {
    expect(computeVerdict([result("unverifiable_disclosed")], "strict", "T1")).toBe("pass");
    expect(computeVerdict([result("unverifiable_disclosed")], "strict", "T2")).toBe("fail");
    expect(computeVerdict([result("unverifiable_disclosed")], "strict", "T3")).toBe("fail");
  });

  it("salvage mode is advisory and always passes", () => {
    expect(computeVerdict([result("failed")], "salvage", "T3")).toBe("pass");
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
