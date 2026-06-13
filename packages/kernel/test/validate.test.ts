import { describe, it, expect } from "vitest";
import { validateArtifact } from "../src/validate.js";

describe("validateArtifact", () => {
  it("accepts a well-formed claim", () => {
    const claim = {
      schema: "quorum.claim/v1",
      id: "clm_000000000001",
      task: "QRM-1",
      agent: "builder",
      type: "file_created",
      subject: { path: "src/a.ts" },
      stated_at: "2026-06-12T03:14:00Z",
    };
    expect(validateArtifact(claim, "quorum.claim/v1")).toEqual({ ok: true });
  });

  it("rejects a claim with the wrong subject shape for its type", () => {
    const bad = {
      schema: "quorum.claim/v1",
      id: "clm_000000000001",
      task: "QRM-1",
      agent: "builder",
      type: "commit_pushed",
      subject: { path: "src/a.ts" }, // commit_pushed needs { sha }
      stated_at: "2026-06-12T03:14:00Z",
    };
    const res = validateArtifact(bad, "quorum.claim/v1");
    expect(res.ok).toBe(false);
  });

  it("reports an unknown schema id", () => {
    const res = validateArtifact({}, "quorum.bogus/v1");
    expect(res).toEqual({ ok: false, errors: ["unknown schema id: quorum.bogus/v1"] });
  });

  it("validates a policy artifact", () => {
    const policy = {
      schema: "quorum.policy/v1",
      default_floor: "T0",
      rules: [{ glob: "schemas/**", floor: "T3" }],
    };
    expect(validateArtifact(policy, "quorum.policy/v1")).toEqual({ ok: true });
  });
});
