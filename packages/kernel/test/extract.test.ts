import { describe, it, expect } from "vitest";
import { extractClaims } from "../src/extract/index.js";

const validClaim = JSON.stringify({
  schema: "quorum.claim/v1",
  id: "clm_000000000001",
  task: "QRM-1",
  agent: "builder",
  type: "file_created",
  subject: { path: "src/a.ts" },
  stated_at: "2026-06-12T03:14:00Z",
});

describe("strict extraction", () => {
  it("parses well-formed claims from a jsonl file", () => {
    const res = extractClaims({ claimsJsonl: `${validClaim}\n` }, "strict");
    expect(res.advisory).toBe(false);
    expect(res.claims).toHaveLength(1);
    expect(res.errors).toHaveLength(0);
  });

  it("reports a parse error on malformed JSON (so the Gate can fail closed)", () => {
    const res = extractClaims({ claimsJsonl: `${validClaim}\n{ not json\n` }, "strict");
    expect(res.claims).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.line).toBe(2);
  });

  it("reads a fenced quorum-claims block from the PR body", () => {
    const body = ["intro", "```quorum-claims", `[${validClaim}]`, "```", "outro"].join("\n");
    const res = extractClaims({ prBody: body }, "strict");
    expect(res.claims).toHaveLength(1);
  });

  // FIX 6 - a duplicate id would let one verified result cover two assertions.
  it("reports a protocol error on duplicate claim ids", () => {
    const res = extractClaims({ claimsJsonl: `${validClaim}\n${validClaim}\n` }, "strict");
    expect(res.errors.some((e) => /duplicate claim id/.test(e.message))).toBe(true);
  });
});

describe("salvage extraction", () => {
  it("mines prose action-claims as advisory claims", () => {
    const res = extractClaims(
      {
        prBody: "I created file src/new.ts and pushed commit a1b2c3d4e5f6 to the branch.",
        task: "QRM-1",
      },
      "salvage",
    );
    expect(res.advisory).toBe(true);
    const types = res.claims.map((c) => c.type).sort();
    expect(types).toContain("file_created");
    expect(types).toContain("commit_pushed");
  });

  // FIX D - reduce false positives on the advisory path.
  it("strips trailing sentence punctuation from path captures", () => {
    const res = extractClaims({ prBody: "I created file src/new.ts.", task: "QRM-1" }, "salvage");
    const created = res.claims.find((c) => c.type === "file_created");
    expect(created?.subject).toEqual({ path: "src/new.ts" });
  });

  it("does not mine claim-like text inside a fenced code block", () => {
    const body = ["Here is an example, do not action it:", "```", "I created file src/ghost.ts", "```"].join("\n");
    const res = extractClaims({ prBody: body, task: "QRM-1" }, "salvage");
    expect(res.claims).toHaveLength(0);
  });

  it("does not mine claim-like text inside a blockquote", () => {
    const body = "> I created file src/quoted.ts\nreal prose with no claim";
    const res = extractClaims({ prBody: body, task: "QRM-1" }, "salvage");
    expect(res.claims).toHaveLength(0);
  });
});
