# QRM-3.4 — cross-family review record

Task: close the delegated/transitive agent-config trust surface. A floored config (CLAUDE.md, opencode.json/.jsonc) steers the agent by *referencing* other in-repo files by content; before this, a PR editing only the referenced file touched a path no static glob floors and graded T0. Opened from the QRM-3.3 R2 red-team finding, sequenced as a QRM-4.0 Gate prerequisite. Reviewers: GPT (cross-architect, design) and Codex (cross-family, red-team). Principles 12 (fail closed), 2 (don't claim more than shipped), 3 (proportionate ceremony), 5 (git is source of truth). Git-tracked so the evidence is not chat-only.

## Design phase (banked before Builder)
Design of record committed (`docs/handoffs/QRM-3.4-design.md`) rather than held in chat. **First-party sourcing was load-bearing and corrected the design twice before a line was implemented:** the handoff's pinned CLAUDE.md `@import` rule (bare `@x` = repo-root) was WRONG — first-party (code.claude.com/docs/en/memory) resolves every relative import against the containing file's directory; and OpenCode `{file:}`/`instructions` resolve config-dir-relative (opencode.ai/docs/config#files), not repo-root. Both were re-prototyped against the real `normalizePath` (10/10) before build. GPT cross-architect review returned six findings, all accepted: P1 opencode config-dir-relative resolution (a real under-floor on nested configs), plus P2/P3 tightening (single `isReferencedPath` matcher, policy annotation requirement, `references`/AGENTS.md residual, fail-closed diagnostics, shared `verify`/`tier` path). Full extractor+resolver prototype: 25/25 against the real kernel.

## Builder
Claude Opus 4.8 at effort xhigh (novel/adversarial T3). 22 files, held at hand-back (no push). Flagged six interpretations; the one genuine trust-boundary edge (whitespace-delimited `@import` tokenization vs trailing punctuation) was correctly escalated, not silently decided.

## Architect re-gate (independent clean clone)
Re-gated from committed bytes, not the hand-back report: fresh clone, cleaned `dist/`, rebuilt, full suite reproduced (217/217 at hand-back). Read every trust-boundary file. Confirmed: uniform `@import` resolution with collapse-then-bounds-check (in-repo `@../sibling` not dropped), string-aware JSONC lexer (defeats the `/**/`-in-string bypass), `{file:}` scoped to instruction-bearing fields, `listFiles` via `git ls-tree -r -z` (C-quoting can't under-floor), single shared matcher and single shared enforcement path resolving at `canonicalForkPoint` (never head), and `ReferenceResolutionError` -> exit 2 (block, not crash). No blocker in the read.

## Cross-family red-team (Codex)
### Round 1 — verdict BLOCK (adjudicated: one fixed, one tracked)
Two reproduced silent under-floors in OpenCode command references:
- **Repro 1 (in scope, FIXED):** `command.*.template` is the prompt sent to the LLM, so a `{file:}` in it loads that file — but the extractor scanned only `agent.*.prompt`/`mode.*.prompt`. A PR editing only the `{file:}` target graded T0. Fixed in-branch by adding `command.*.template` to the instruction-bearing `{file:}` allowlist; reproduced -> T3 through the built CLI; +2 tests.
- **Repro 2 (OUT of scope, TRACKED):** command-prompt `@file` includes are a *distinct* mechanism — auto-included and repo-ROOT-relative ("commands run in your project's root directory"), spanning both `command.*.template` and `.opencode/commands/**/*.md`. A different resolution base and grammar; implementing it from an inferred base is the exact wrong-base trap first-party sourcing exists to prevent. Adjudicated out of QRM-3.4's defined scope (claude-md `@import` + opencode.json instructions/`{file:}`).

Adjudication (Architect + Owner): the Repro 1 fix means QRM-3.4 does not overclaim on command templates; Repro 2 is scoped out explicitly in acceptance and opened as a first-class QRM-4.0 residual (repo-root base sourced now to de-risk the follow-up). The override of the BLOCK-as-QRM-3.4-blocker is legitimate: out of scope, pre-existing, not overclaimed, documented here AND tracked. Codex was not asked to retract its verdict.

### Re-verify — verdict PASS
Because the Repro 1 fix was Architect-authored (same family as the Builder), cross-family re-verification was mandatory (no exemption). Codex confirmed from a fresh clean build: Repro 1 -> T3; Repro 2 correctly still the tracked residual (not silently swept); sibling sweep found no other missed in-scope `{file:}` field — notably `command.*.description` correctly does NOT floor (a UI label, not instruction-bearing), and absolute/`~` in a command template still BLOCKS.

## Standing lesson
Enumerated allowlists are fail-open by omission — the same lesson as QRM-3.3's enumerated dotdirs, now at the field level: the instruction-bearing `{file:}` allowlist missed `command.*.template`. And reference grammars must be first-party-sourced, never implemented from memory: this surface has *three* different resolution bases (claude-md `@import` = containing-file; opencode `{file:}`/`instructions` = config-dir; command `@file` = repo-root), and two were mis-stated in the handoff before sourcing corrected them. The durable posture: source the base, prototype against the real kernel, and let cross-family red-team probe the allowlist for omissions.

## Disposition
Shipped as PR #17 (squash `3492100`, parent `06a165b`). Independently re-verified from a clean clone of main after merge: build clean, full suite 219/219 across 24 files. Deferred and tracked in QRM-4.0: Cursor `.mdc` transitive refs; OpenCode command-prompt `@file` (repo-root, spans JSON templates + `.opencode/commands/**/*.md`); OpenCode `references` object + manual AGENTS.md `@refs`; authenticated-forge `listFiles`; and the unproven claude-md `@import` punctuation-termination question (no `claude` binary available to the red-team).

## Provenance
Re-verified from main after merge: squash `3492100`, parent `06a165b`. QRM-3.4 manifest flipped to merged in this bookkeeping change; QRM-4.0 carries the delegated-reference residuals opened above.
