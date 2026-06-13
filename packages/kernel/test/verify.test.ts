import { describe, it, expect } from "vitest";
import { MemoryForge } from "../src/forge/memory.js";
import { verifyClaim } from "../src/verify/index.js";
import { sha256 } from "../src/hash.js";
import { mkClaim } from "./fixtures/amas.js";

const ctx = { head: "HEAD", mergeBase: "BASE" };

describe("file claims", () => {
  it("file_created verifies when present; records sha256", async () => {
    const forge = new MemoryForge({ files: { HEAD: { "a.ts": "x\n" } } });
    const r = await verifyClaim(mkClaim({ type: "file_created", subject: { path: "a.ts" } }), forge, ctx);
    expect(r.status).toBe("verified");
    expect(r.evidence["sha256"]).toBe(sha256("x\n"));
  });

  it("file_modified fails when unchanged from merge-base", async () => {
    const forge = new MemoryForge({ files: { HEAD: { "a.ts": "x\n" }, BASE: { "a.ts": "x\n" } } });
    const r = await verifyClaim(mkClaim({ type: "file_modified", subject: { path: "a.ts" } }), forge, ctx);
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("unchanged_from_merge_base");
  });

  it("file_modified verifies when content differs from merge-base", async () => {
    const forge = new MemoryForge({ files: { HEAD: { "a.ts": "y\n" }, BASE: { "a.ts": "x\n" } } });
    const r = await verifyClaim(mkClaim({ type: "file_modified", subject: { path: "a.ts" } }), forge, ctx);
    expect(r.status).toBe("verified");
  });

  it("file_deleted verifies when absent at head but present at base", async () => {
    const forge = new MemoryForge({ files: { HEAD: {}, BASE: { "a.ts": "x\n" } } });
    const r = await verifyClaim(mkClaim({ type: "file_deleted", subject: { path: "a.ts" } }), forge, ctx);
    expect(r.status).toBe("verified");
  });

  it("file_deleted fails when the file is still present", async () => {
    const forge = new MemoryForge({ files: { HEAD: { "a.ts": "x\n" }, BASE: { "a.ts": "x\n" } } });
    const r = await verifyClaim(mkClaim({ type: "file_deleted", subject: { path: "a.ts" } }), forge, ctx);
    expect(r.status).toBe("failed");
  });
});

describe("forge-only claims fall to unverifiable_disclosed when unsupported", () => {
  // This is the off-ramp guarantee: LocalGitForge can't answer these, and the
  // honest status is disclosed-unverifiable, never a fabricated verified.
  const forge = new MemoryForge({
    unsupported: ["getPR", "getIssue", "getReviewsAllEndpoints", "getCheckRuns"],
  });

  it("test_passed → disclosed when checks are unreadable", async () => {
    const r = await verifyClaim(
      mkClaim({ type: "test_passed", subject: { check_name: "ci" } }),
      forge,
      ctx,
    );
    expect(r.status).toBe("unverifiable_disclosed");
  });

  it("pr_opened / issue_filed / review_posted → disclosed", async () => {
    for (const claim of [
      mkClaim({ type: "pr_opened", subject: { number: 1 } }),
      mkClaim({ type: "issue_filed", subject: { number: 2 } }),
      mkClaim({ type: "review_posted", subject: { pr: 3 } }),
    ]) {
      expect((await verifyClaim(claim, forge, ctx)).status).toBe("unverifiable_disclosed");
    }
  });
});

describe("identity-scoped claims", () => {
  it("issue_filed fails when author is not the claiming identity", async () => {
    const forge = new MemoryForge({ issues: { 9: { author: "random-user" } } });
    const r = await verifyClaim(
      mkClaim({ type: "issue_filed", subject: { number: 9 } }),
      forge,
      { ...ctx, identity: "quorum-gate[bot]" },
    );
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("issue_author_mismatch");
  });

  it("test_passed fails when the named check did not succeed", async () => {
    const forge = new MemoryForge({ checks: { HEAD: [{ name: "ci", conclusion: "failure" }] } });
    const r = await verifyClaim(
      mkClaim({ type: "test_passed", subject: { check_name: "ci" } }),
      forge,
      ctx,
    );
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("check_not_successful");
  });
});
