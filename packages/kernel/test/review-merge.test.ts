import { describe, it, expect } from "vitest";
import { mergeReviewEndpoints } from "../src/forge/review-merge.js";
import type { ReviewItem } from "../src/forge/adapter.js";

const at = (id: string, surface: ReviewItem["surface"], submitted_at: string): ReviewItem => ({
  id,
  surface,
  author: "gpt-codex",
  submitted_at,
});

describe("mergeReviewEndpoints", () => {
  it("orders by (submitted_at, id) and preserves every emission", () => {
    const merged = mergeReviewEndpoints(
      [at("b", "review", "2026-06-12T03:14:00Z")],
      [at("a", "issue_comment", "2026-06-12T03:14:00Z")],
      [at("c", "line_comment", "2026-06-12T03:14:01Z")],
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("is order-independent across input endpoints (deterministic tie-break)", () => {
    const a = at("a", "issue_comment", "2026-06-12T03:14:00Z");
    const b = at("b", "review", "2026-06-12T03:14:00Z");
    const forward = mergeReviewEndpoints([b], [a], []);
    const reversed = mergeReviewEndpoints([], [a], [b]);
    expect(forward.map((m) => m.id)).toEqual(reversed.map((m) => m.id));
    expect(forward.map((m) => m.id)).toEqual(["a", "b"]);
  });
});
