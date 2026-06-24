import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Policy } from "@quorum/contracts";
import { computeTierFloor } from "../src/tier/floor.js";

// Load the REAL committed policy from the repo root (test file lives at
// packages/kernel/test/, so the repo root is three levels up). The point of
// this test is that deleting an agent-config rule from the committed
// .quorum/policy.json breaks CI - so we must NOT inline a synthetic policy.
const policyPath = fileURLToPath(new URL("../../../.quorum/policy.json", import.meta.url));
const policy: Policy = JSON.parse(readFileSync(policyPath, "utf8")) as Policy;

// Agent operating-config paths that MUST be floored to T3. These are the files
// that steer coding agents (CLAUDE.md, .claude/**, AGENTS.md, MCP config, Cursor
// and Copilot rules, Codex config); a change to any of them is high-trust.
const mustFloorToT3 = [
  "CLAUDE.md",
  "packages/kernel/CLAUDE.md",
  "claude.md",
  "CLAUDE.local.md",
  ".claude/settings.json",
  "packages/app/.claude/settings.json",
  ".claude/hooks/pre-tool-use.sh",
  ".claude/skills/x/SKILL.md",
  ".claude/commands/foo.md",
  ".claude/mcp.json",
  "AGENTS.md",
  "docs/AGENTS.md",
  "AGENTS.override.md",
  "packages/kernel/AGENTS.override.md",
  ".codex/config.toml",
  "packages/app/.codex/config.toml",
  ".agents/skills/release/SKILL.md",
  "packages/x/.agents/skills/y/SKILL.md",
  ".mcp.json",
  "sub/.mcp.json",
  ".vscode/mcp.json",
  "sub/.vscode/mcp.json",
  ".github/copilot-instructions.md",
  ".github/agents/reviewer.agent.md",
  ".github/instructions/ts.instructions.md",
  ".cursor/rules/x.mdc",
  "packages/app/.cursor/rules/security.mdc",
  ".cursorrules",
  ".cursorignore",
  ".claude",
  "a/b/.claude",
  ".codex",
  "a/b/.codex",
  ".cursor",
  ".vscode",
  ".agents",
  ".agents/skills",
  "packages/p/foo.agent.md",
  "x.instructions.md",
  ".github",
  ".github/agents",
  ".github/instructions",
];

// Near-misses: superficially similar paths that must NOT be over-matched. The
// floor fails closed (over-matching only raises the tier), so an accidental
// over-broad glob would silently catch these - assert they stay at the default.
const nearMisses = [
  "claudette.md",
  "my-agents-helper.md",
  "src/agents.md.bak",
  "README.md",
  "docs/PRINCIPLES.md",
  "docs/copilot-instructions.md",
  "subdir/copilot-instructions.md",
  ".cursorindexingignore",
  ".vscode/settings.json",
  "sub/.vscode/launch.json",
  "docs/instructions/x.md",
  "foo/.github/instructions/x.md",
  "foo/.github/agents/x.md",
  ".github/agents/README.md",
  ".github/instructions/README.md",
  ".github/instructions/logo.png",
  ".agents/config.yaml",
  "foo/.github",
  "foo/.github/agents",
];

describe("agent operating-config tier floor (real committed policy)", () => {
  it("floors every agent-config path to T3", () => {
    for (const path of mustFloorToT3) {
      expect(computeTierFloor([path], policy), `${path} should floor to T3`).toBe("T3");
    }
  });

  it("does not over-match near-miss paths (they stay at the default floor)", () => {
    for (const path of nearMisses) {
      const floor = computeTierFloor([path], policy);
      expect(floor, `${path} should resolve to the default floor`).toBe(policy.default_floor);
      expect(floor, `${path} must not be floored to T3`).not.toBe("T3");
    }
  });
});
