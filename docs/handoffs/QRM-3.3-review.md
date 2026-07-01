# QRM-3.3 — cross-family review record

Task: extend the QRM-3.0 agent-config tier floor to harness/agent-control surfaces missed by the original enumeration, surfaced by a cross-check against the ECC harness pack (github.com/affaan-m/ECC) plus first-party harness docs. Reviewers: GPT (cross-architect, design) and Codex (cross-family, red-team). Principles 12 (fail closed), 2 (don't claim more than shipped), 3 (proportionate ceremony), 5 (git is source of truth). Git-tracked so the evidence is not chat-only.

## Cross-architect (GPT) design review
Finalized the exact rule set from the ECC cross-check: confirmed the dotdir gaps, added .devin/rules (Windsurf has become Devin Desktop; .devin/rules is the preferred path, .windsurf/rules the fallback — including one without the other would ship a known omission), and the Gemini control files (GEMINI.md, .geminiignore, .aiexclude) as the same trust class as CLAUDE.md/.cursorignore. Rejected speculative additions (codex.md, broad .windsurf/**) for lack of first-party sourcing. PROCEED-TO-BUILDER, skip prototype (mechanical + tests are the de-risking).

## Cross-family red-team (Codex)
### Round 1 — verdict BLOCK (fixed)
Several harnesses put agent-control config at the REPO ROOT, not under their dotdir; QRM-3.3 floored the dotdirs but missed the root files: OpenCode root opencode.json/.jsonc (.opencode/** is a separate surface); Qwen root QWEN.md + .qwenignore/.agentignore/.aiignore; Zed/cross-harness root .rules/.clinerules/AGENT.md (singular — distinct from the already-floored AGENTS.md). Fixed by adding component-exact root-file globs; over-match negatives and an AGENT.md-vs-AGENTS.md boundary test added.

### Follow-ons on the open PR (fixed)
- P1: .clinerules is a DIRECTORY (Cline workspace-rules layout); the bare **/.clinerules glob did not floor files beneath it. Added **/.clinerules/**.
- P2: .clineignore (controls which files Cline can access) was un-floored while other harness ignore files were. Added **/.clineignore.

### Round 2 — BLOCK, adjudicated OUT OF SCOPE -> QRM-3.4
Codex confirmed the static-path coverage is clean, and separately surfaced a distinct threat class QRM-3.3 does not own: DELEGATED/transitive references. A floored config can point at arbitrary non-dotdir files — OpenCode opencode.json `instructions: [...]` and prompt `{file:./path}`, CLAUDE.md @import, Cursor rule refs. A PR editing only the referenced file (e.g. docs/*.md, prompts/*.txt) computes the default floor. This is NOT closable by static globs (no fixed path) and NOT closed by the deferred fail-closed dotdir inversion (referenced files aren't dotdirs). It is PRE-EXISTING on main; QRM-3.3 neither introduces nor worsens it, and makes no claim of complete agent-config coverage.

Adjudication (Architect + Owner): scoping this out of QRM-3.3 is correct — a different, harder threat class revealed by red-teaming, not something QRM-3.3 undertook. Overriding the BLOCK as a QRM-3.3 blocker is legitimate because (1) it is out of QRM-3.3's enumerated-static-path scope, (2) it is pre-existing, (3) QRM-3.3 does not overclaim, (4) it is documented here AND opened as a first-class prioritized task (QRM-3.4), sequenced as a QRM-4.0 Gate prerequisite. The red-team advises; the Architect and Owner adjudicate scope; Codex was NOT asked to retract its verdict.

## Standing lesson
This is the second and third independent finding of missing surface in an ENUMERATED floor (GPT's dotdir cross-check; Codex's root-file + Cline rounds). Enumerated trust-surface lists are fail-open by omission. The durable fixes are QRM-3.4 (delegated references) and the strategic fail-closed dotdir inversion (a separate tracked task) — not hand-maintaining the list per harness release. Stopping rule adopted: in-scope static-path defects on the current branch are fixed; newly-named harnesses become evidence for the inversion, not an unbounded amend tail.

## Disposition
Shipped as PR #12 (squash f3724b0). Independently re-verified from a clean clone at each tip (agent-config 12/12, full suite 165/165). Deferred and tracked: QRM-3.4 (delegated references, Gate prerequisite); fail-closed dotdir inversion; retirement of the mode-redundant bare **/.X entries.

## Provenance
Re-verified from main after merge: squash f3724b0, parent 64d9723. QRM-3.3 manifest flipped to merged in this bookkeeping change; QRM-3.4 committed as planned; QRM-4.0 gains the delegated-reference prerequisite.
