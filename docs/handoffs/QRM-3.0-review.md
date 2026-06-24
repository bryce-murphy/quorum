# QRM-3.0 — cross-family red-team record

Task: floor agent operating-config to T3 (`.quorum/policy.json`) + bank PMN-002.
Reviewer: Codex (GPT family); Builder/Architect: Claude family. Principle 7 (cross-family review), principle 10 (external evidence). This record exists so the evidence is git-tracked, not chat-only (principle 5).

Three adversarial rounds ran against successive rule sets. Each found defects that same-family review (Architect re-read + green suite) had passed. Summary below; each finding includes the reproduction that drove the fix.

## Round 1 — original 9-rule set
- **Nested directory evasion (fixed):** `.codex/**` and `.cursor/**` lacked a leading `**/`, so `packages/app/.codex/config.toml` resolved to T0. Re-anchored to `**/.codex/**`, `**/.cursor/**` (and `**/.claude/**` for consistency).
- **Missing coverage (fixed):** `AGENTS.override.md` (Codex precedence file), `.agents/skills/**` (Codex skills), `.vscode/mcp.json` (MCP tool access), `.github/agents/**` + `.github/instructions/**` (Copilot/VS Code steering) were all T0. Added.
- **Copilot over-match (fixed):** `**/copilot-instructions.md` floored `docs/copilot-instructions.md`, which Copilot never loads. Pinned to `.github/copilot-instructions.md`.
- **Declined / deferred:** `.cursorindexingignore` (indexing-only, out of scope); policy-and-test deletable together at T0 (general policy-from-PR-head weakness, deferred to M3 Gate); `CLAUDE.md @import` transclusion (needs dependency-aware enforcement, deferred).
- Result: revised to 15 rules.

## Round 2 — 15-rule set — verdict BLOCK
- **Bare-directory symlink/gitlink evasion (P1, fixed):** a tracked symlink or submodule at a bare reserved path (`.claude`, `.codex`, `.cursor`, `.agents/skills`, `.vscode`) resolved to T0 while the agent read config through the link, because `**/.claude/**` requires a child segment. Repro: `ln -s agent-config .claude; git add .claude` -> diff path `.claude` => T0. Added bare-path rules (`**/.claude`, etc.).
- **GitHub directory over-match (P2, fixed):** `.github/agents/**` / `.github/instructions/**` floored every file incl. `README.md` and images. Switched to filename patterns `**/*.agent.md`, `**/*.instructions.md` (precise + symlink-robust).
- **`.cursorignore` fixture (P3, accepted residual):** `test/fixtures/.cursorignore` => T3 — accepted fail-closed tradeoff.
- Result: revised to 21 rules.

## Round 3 — 21-rule set — verdict BLOCK
- **Incomplete bare-dir closure (fixed):** `.github`, `.github/agents`, `.github/instructions` bare symlink paths still resolved to T0 (the P2 filename-pattern swap removed their dir rules). Repro: `ln -s ../shared-agents .github/agents` -> diff path `.github/agents` => T0. Added the 3 bare `.github` rules -> 24 rules.
- **Arbitrary-path symlink/gitlink indirection (architectural, deferred):** a symlink/submodule at *any* path (e.g. `packages/app`) can carry reserved files that never appear in the outer diff, so no path glob can catch it. This is a general tier-floor-mechanism gap (affects all floored classes, pre-exists QRM-3.0). NOT glob-fixable. Deferred to **QRM-3.1** (mode-aware floor: floor any changed mode `120000`/`160000` entry to T3), committed as a pre-Gate blocker.
- **Filename-suffix bounded over-match (P3, accepted residual):** `docs/http.agent.md` => T3 — accepted, suffixes are specialized enough.

## Disposition
The arbitrary-path indirection residual was ratified-as-deferred by the Owner, with a cross-architect (GPT) second opinion (SHIP-WITH-DEFER, conditional on: honest scope language in the PR; QRM-3.1 committed and marked a pre-L2-Gate blocker). Both conditions met in QRM-3.0 (PR #6). The L2 Gate is not complete tier-floor enforcement until QRM-3.1 lands.

## Provenance
Re-verified from `main` after merge: squash commit `66bc511`, parent `442f68b`; fast-forward applied the six gated files; `quorum verify --task QRM-3.0` declines correctly on `main` (empty self-delta); `validate` ok on the merged policy.
