# Quorum design principles

These twelve principles are the spine of Quorum. Every architectural decision, every Action, every artifact schema must be traceable to one of them. They are deliberately few and stated plainly — Quorum's predecessor failed partly by accreting hundreds of cross-referenced rules with no readable core. If a principle here stops earning its place, it is retired (principle 11 applies to this list too).

## 1. Verify, don't trust

Every agent claim about external state — a file exists, a commit landed, a test passed, a review happened — is unverified until checked mechanically against actual state. The output of verification is visible (a claim ledger), not assumed.

## 2. Enforce in code, document in prose

Any rule stated more than twice becomes a schema, a lint, or an Action. Prose that *could* be a check is debt. Quorum does not claim enforcement it has not shipped.

## 3. Risk-tiered ceremony from day one

Process weight scales with blast radius. A typo and a schema migration do not share a pipeline. The lightweight path is the default; heavy tiers are opt-in. Tiering is a v0.1 property, not a someday feature.

## 4. Shared substrate, not a human relay

Agents coordinate through the repository and the forge, with direct scoped access, instead of a human copy-pasting between chat windows. The human is the accountability gate, not the transport. This is the single biggest correction over the predecessor.

## 5. Git is the source of truth; any external store is an optional operational cache

Canonical, diff-reviewable truth lives in git, which preserves owner-ratification-by-diff. The task/decision graph, claim ledger of record, telemetry, and audit log have a git-native home by default. An external store — adopted only when a project needs it — holds a derived index or event cache, never the canonical record, and is never a core dependency.

## 6. Machine-first artifacts, human-readable views

Handoffs, reviews, decisions, and claims are structured data validated in CI. Markdown is a rendered view of that data, not the store. This makes artifacts a deterministic parse target for agents and a readable surface for humans at the same time.

## 7. Cross-family review, always

The agent that builds and the agent that reviews come from different model families. Independence catches correlated single-family failures, and it matters *more* as human relay decreases.

## 8. Token budgets are architecture

Agent-facing law fits in roughly two thousand tokens, with progressive disclosure for the rest. If an agent must ingest fifty thousand tokens to fix a typo, the law is wrong. The framework's own context cost must not work against the efficiency it promises.

## 9. Generated ceremony

Agents and humans never hand-author boilerplate. Scaffolding emits conformant artifacts, so conformance is free rather than a discipline that erodes.

## 10. External evidence or it didn't happen

A discipline is promoted to canonical only on evidence from outside the pipeline that produced it: a measured outcome, a cross-domain data point, or an external adopter. The pipeline confirming itself is not evidence. Independent cross-model review counts as a second-tier source.

## 11. Delete by default

Every discipline carries a sunset trigger. Ceremony that catches no defect across a defined number of instrumented cycles becomes a removal candidate. A learning loop that can only add is accreting, not learning.

## 12. Security is a first-class, agent-native axis

Agents process untrusted content (issue and PR bodies, fork diffs, tool output) while holding tool access — a live prompt-injection and exfiltration surface. No single agent context simultaneously holds untrusted input, sensitive access, and state-change or egress capability (three-factor isolation). Each agent runs under least-privilege identity. Circuit-breakers fail to the human. Safety-critical checks fail closed; documentation niceties fail open.
