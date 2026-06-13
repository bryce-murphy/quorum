import { describe, it, expect } from "vitest";
import { MemoryForge } from "../src/forge/memory.js";
import { verifyClaim } from "../src/verify/index.js";
import {
  subShapeA,
  subShapeB,
  threeEndpoint,
  postHandback,
} from "./fixtures/amas.js";

// The AMAS fixture suite is the Phase 1 acceptance bar (SPEC 4, 6).

describe("AMAS Sub-shape A - fully fabricated claim", () => {
  const forge = new MemoryForge(subShapeA.forge);

  it("marks a nonexistent file claim failed", async () => {
    const r = await verifyClaim(subShapeA.fabricatedFile, forge, subShapeA.ctx);
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("file_absent_at_head");
  });

  it("marks an unresolvable commit SHA failed", async () => {
    const r = await verifyClaim(subShapeA.fabricatedCommit, forge, subShapeA.ctx);
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("commit_unresolvable");
  });
});

describe("AMAS Sub-shape B - correct content, phantom citation", () => {
  const forge = new MemoryForge(subShapeB.forge);

  it("fails the citation but records the content-hash match as evidence", async () => {
    const r = await verifyClaim(subShapeB.phantomCitationRealContent, forge, subShapeB.ctx);
    // The asserted action (this commit landing) did NOT happen -> failed ...
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("commit_unresolvable");
    // ... but the finding is still real, and that distinction is preserved.
    expect(r.evidence["content_match"]).toBe(true);
    expect(r.evidence["matched_path"]).toBe("src/found.ts");
  });
});

describe("AMAS three-endpoint poll with same-second tie-break", () => {
  const forge = new MemoryForge(threeEndpoint.forge);

  it("finds the review across surfaces and drops nothing on a same-second tie", async () => {
    const r = await verifyClaim(threeEndpoint.anySurface, forge, threeEndpoint.ctx);
    expect(r.status).toBe("verified");
    const polled = r.evidence["polled"] as Array<{ id: string }>;
    // a (issue_comment) and b (review) share 03:14:00Z; c is 03:14:01Z.
    // Deterministic order is (submitted_at, id): a, b, c - none dropped.
    expect(polled.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("matches a specific requested surface", async () => {
    const r = await verifyClaim(threeEndpoint.lineCommentSurface, forge, threeEndpoint.ctx);
    expect(r.status).toBe("verified");
    expect(r.evidence["matched_id"]).toBe("c");
    expect(r.evidence["surface"]).toBe("line_comment");
  });
});

describe("AMAS post-handback five-point check", () => {
  const forge = new MemoryForge(postHandback.forge);
  const ctx = postHandback.ctx;

  it("(1) polls reviewer output", async () => {
    expect((await verifyClaim(postHandback.reviewPoll, forge, ctx)).status).toBe("verified");
  });

  it("(2) confirms the branch tip SHA", async () => {
    expect((await verifyClaim(postHandback.branchTip, forge, ctx)).status).toBe("verified");
  });

  it("(3) confirms file content vs claim, and fails a wrong hash", async () => {
    expect((await verifyClaim(postHandback.contentMatches, forge, ctx)).status).toBe("verified");
    const bad = await verifyClaim(postHandback.contentMismatch, forge, ctx);
    expect(bad.status).toBe("failed");
    expect(bad.evidence["reason"]).toBe("content_hash_mismatch");
  });

  it("(4) phantom-action audit catches a fabricated file", async () => {
    expect((await verifyClaim(postHandback.phantomAudit, forge, ctx)).status).toBe("failed");
  });

  it("(5) fails a comment-content claim on a surface that did not emit", async () => {
    const r = await verifyClaim(postHandback.missingSurface, forge, ctx);
    expect(r.status).toBe("failed");
    expect(r.evidence["reason"]).toBe("no_review_on_surface");
  });
});
