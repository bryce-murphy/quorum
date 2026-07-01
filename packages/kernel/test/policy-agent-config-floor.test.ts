import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Policy } from "@quorum/contracts";
import { computeTierFloor } from "../src/tier/floor.js";
import { globMatches } from "../src/tier/glob.js";
import type { DiffEntry } from "../src/diff.js";

/** A single ordinary (regular-file, mode 100644) changed entry - this suite
 *  exercises PATH-glob flooring, so modes must be ordinary or the QRM-3.1 mode
 *  floor would mask the near-miss assertions. */
const entry = (path: string): DiffEntry[] => [
  { status: "M", oldMode: "100644", newMode: "100644", path },
];

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
  // ".agents/config.yaml" moved to qrm33MustFloorToT3 below: QRM-3.3
  // deliberately broadens **/.agents/** beyond the skills subtree, so this
  // path is no longer a near-miss - it is a genuine, intended positive.
  "foo/.github",
  "foo/.github/agents",
];

describe("agent operating-config tier floor (real committed policy)", () => {
  it("floors every agent-config path to T3", () => {
    for (const path of mustFloorToT3) {
      expect(computeTierFloor(entry(path), policy), `${path} should floor to T3`).toBe("T3");
    }
  });

  it("does not over-match near-miss paths (they stay at the default floor)", () => {
    for (const path of nearMisses) {
      const floor = computeTierFloor(entry(path), policy);
      expect(floor, `${path} should resolve to the default floor`).toBe(policy.default_floor);
      expect(floor, `${path} must not be floored to T3`).not.toBe("T3");
    }
  });
});

// ---------------------------------------------------------------------------
// QRM-3.3 — harness-config coverage extension. Surfaced by a cross-check
// against the ECC harness pack + first-party harness docs: agent-control
// surfaces (Claude/Codex plugin dirs, Gemini, Zed, opencode, Kiro, Trae, Qwen,
// CodeBuddy, Windsurf/Devin rules subdirs, agent.yaml) that QRM-3.0's rules
// did not cover, plus broadening .agents/** beyond the skills subtree.
// ---------------------------------------------------------------------------

const qrm33MustFloorToT3 = [
  ".gemini/config.json",
  "foo/.gemini/x",
  ".claude-plugin/x",
  ".codex-plugin/x",
  ".zed/x",
  ".opencode/x",
  ".kiro/steering/x.md",
  ".trae/x",
  ".qwen/x",
  ".codebuddy/x",
  "GEMINI.md",
  "foo/GEMINI.md",
  ".geminiignore",
  ".aiexclude",
  ".windsurfrules",
  ".windsurf/rules/x.md",
  ".devin/rules/x.md",
  "agent.yaml",
  "foo/agent.yaml",
  ".agents/rules/x.md",
  ".agents/config.yaml",
  "opencode.json",
  "packages/app/opencode.json",
  "opencode.jsonc",
  "QWEN.md",
  "docs/QWEN.md",
  ".qwenignore",
  ".agentignore",
  ".aiignore",
  ".rules",
  ".clinerules",
  ".clinerules/coding.md",
  ".clinerules/rules/security.md",
  "foo/.clinerules/x.md",
  ".clineignore",
  "packages/app/.clineignore",
  "AGENT.md",
  "docs/AGENT.md",
];

// Case-varied positives: glob.ts matches case-insensitively (deliberate
// fail-closed choice - see glob.ts) so case-varying filesystems can't evade a
// floor. These are still the real config surface, just differently cased -
// NOT an over-match.
const qrm33CaseInsensitivePositives = [".GEMINI/config.json", "Agent.yaml", "gemini.md"];

// Near-misses: benign look-alikes that must NOT be floored. Every QRM-3.3 rule
// is component-exact (anchored full-string match, requires a path-segment
// boundary), so a suffix/prefix collision like ".geminix" or "agent.yaml.bak"
// must stay at the default floor.
const qrm33Negatives = [
  ".geminix/x",
  ".gemini-old/x",
  "foo.gemini/x",
  ".claude-plugin-backup/x",
  "GEMINI.md.bak",
  "my-GEMINI.md",
  ".geminiignore.bak",
  "foo.geminiignore",
  ".aiexclude.bak",
  "my-agent.yaml",
  "agent.yaml.bak",
  "agents/manifest.yaml",
  ".windsurfing/rules/x.md",
  ".windsurf/rules.bak/x.md",
  ".devin-old/rules/x.md",
  ".agents-old/x.md",
  ".agentss/x.md",
  "foo.agents/x.md",
  "opencode.json.bak",
  "my-opencode.json",
  "opencode.yaml",
  "QWEN.md.bak",
  "my-QWEN.md",
  ".qwenignore.bak",
  ".rules.bak",
  "my.rules",
  "foo.rules",
  "AGENT.md.bak",
  "my-AGENT.md",
  "AGENTS.md.bak",
  ".clinerules-old/x.md",
  "my.clinerules",
  ".clineignore.bak",
  "my-.clineignore",
];

describe("QRM-3.3 LEVEL 1 - direct globMatches precision (harness-config gaps)", () => {
  const matchesAnyRule = (path: string): boolean => policy.rules.some((r) => globMatches(r.glob, path));

  it("matches every new harness-config positive", () => {
    for (const path of qrm33MustFloorToT3) {
      expect(matchesAnyRule(path), `${path} should match a T3 rule`).toBe(true);
    }
  });

  it("matches case-varied positives case-insensitively (intentional fail-closed)", () => {
    for (const path of qrm33CaseInsensitivePositives) {
      expect(matchesAnyRule(path), `${path} should match case-insensitively`).toBe(true);
    }
  });

  it("does not over-match benign look-alikes", () => {
    for (const path of qrm33Negatives) {
      expect(matchesAnyRule(path), `${path} should NOT match any T3 rule`).toBe(false);
    }
  });

  it("near-miss gap proof: pre-existing .claude rules do not cover .claude-plugin (QRM-3.3 closes a real hole)", () => {
    expect(globMatches("**/.claude", ".claude-plugin/x")).toBe(false);
    expect(globMatches("**/.claude/**", ".claude-plugin/x")).toBe(false);
    expect(matchesAnyRule(".claude-plugin/x")).toBe(true);
  });

  it("broaden proof: .agents/** now covers paths beyond the skills subtree", () => {
    expect(matchesAnyRule(".agents/rules/x.md")).toBe(true);
    // pre-existing skills-subtree behavior is unchanged
    expect(matchesAnyRule(".agents/skills/release/SKILL.md")).toBe(true);
  });

  it("boundary proof: AGENT.md (singular) and AGENTS.md (plural) are distinct, non-colliding rules", () => {
    expect(globMatches("**/AGENT.md", "AGENT.md")).toBe(true);
    expect(globMatches("**/AGENT.md", "AGENTS.md")).toBe(false);
    expect(globMatches("**/AGENTS.md", "AGENTS.md")).toBe(true);
    expect(globMatches("**/AGENTS.md", "AGENT.md")).toBe(false);
    expect(matchesAnyRule("AGENT.md")).toBe(true);
    expect(matchesAnyRule("AGENTS.md")).toBe(true);
    expect(matchesAnyRule("my-AGENT.md")).toBe(false);
  });
});

describe("QRM-3.3 LEVEL 2 - computeTierFloor integration (real committed policy)", () => {
  it("floors every new harness-config positive to T3", () => {
    for (const path of [...qrm33MustFloorToT3, ...qrm33CaseInsensitivePositives]) {
      expect(computeTierFloor(entry(path), policy), `${path} should floor to T3`).toBe("T3");
    }
  });

  it("does not raise the floor for benign look-alikes", () => {
    for (const path of qrm33Negatives) {
      const floor = computeTierFloor(entry(path), policy);
      expect(floor, `${path} should resolve to the default floor`).toBe(policy.default_floor);
      expect(floor, `${path} must not be floored to T3`).not.toBe("T3");
    }
  });

  it("a diff touching only .gemini/config.json floors to T3 from an otherwise-T0 default", () => {
    expect(policy.default_floor).toBe("T0");
    expect(computeTierFloor(entry(".gemini/config.json"), policy)).toBe("T3");
  });

  it("a diff touching only a negative look-alike (.geminix/x) stays at the default floor", () => {
    expect(computeTierFloor(entry(".geminix/x"), policy)).toBe(policy.default_floor);
  });
});
