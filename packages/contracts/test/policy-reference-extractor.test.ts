import { describe, it, expect } from "vitest";
import { PolicyRuleSchema, PolicySchema } from "../src/policy.js";

// QRM-3.4 - `reference_extractor` is a STRICT optional enum on a policy rule. The
// policy is the auditable trust surface: an unknown extractor value must
// schema-FAIL (fail closed), never be silently ignored.
describe("QRM-3.4 policy rule reference_extractor", () => {
  it("accepts a rule with no reference_extractor (backward compatible)", () => {
    const r = PolicyRuleSchema.safeParse({ glob: "src/**", floor: "T3" });
    expect(r.success).toBe(true);
  });

  it("accepts the two known extractors", () => {
    for (const ext of ["claude-md", "opencode-json"]) {
      const r = PolicyRuleSchema.safeParse({ glob: "**/x", floor: "T3", reference_extractor: ext });
      expect(r.success, `${ext} should parse`).toBe(true);
    }
  });

  it("rejects an unknown extractor value (fail closed)", () => {
    const r = PolicyRuleSchema.safeParse({
      glob: "**/x",
      floor: "T3",
      reference_extractor: "cursor-mdc",
    });
    expect(r.success).toBe(false);
  });

  it("still rejects unknown extra keys (.strict preserved)", () => {
    const r = PolicyRuleSchema.safeParse({ glob: "**/x", floor: "T3", extractor: "claude-md" });
    expect(r.success).toBe(false);
  });

  it("a full policy with annotated rules parses", () => {
    const p = PolicySchema.safeParse({
      schema: "quorum.policy/v1",
      default_floor: "T0",
      rules: [
        { glob: "**/CLAUDE.md", floor: "T3", reference_extractor: "claude-md" },
        { glob: "**/opencode.jsonc", floor: "T3", reference_extractor: "opencode-json" },
        { glob: "schemas/**", floor: "T3" },
      ],
    });
    expect(p.success).toBe(true);
  });
});
