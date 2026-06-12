# Quorum glossary

> **Stub.** This glossary is seeded with the core terms needed to read the bootstrap docs. Per principle 2 (enforce in code) and Decision 9 (adoption layer), the long-term intent is to **generate this glossary from term definitions in source** so it never drifts. Until that ships, it is maintained by hand. Every term that appears in Quorum canonical text must be defined here — if you find an undefined term, that is a bug.

A central lesson from the predecessor (AMAS) is that an undefined private vocabulary is an adoption blocker. Quorum keeps the term count low and every term plain.

## Roles

- **Architect (Planner)** — the agent that produces a task's manifest and implementation contract before work begins.
- **Builder (Implementer)** — the agent that does the work on a branch, with scoped repository access via the forge App.
- **Reviewer (Checker)** — the independent, cross-family agent that reviews changes; auto-invoked on every push.
- **Red-team** — the agent that runs an adversarial pass on high-risk tasks.
- **Cross-review / critic** — a model-family-independent agent that critiques architectural decisions.
- **Verifier** — a deterministic (non-LLM) component that extracts claims and checks them against repository state, emitting the claim ledger.
- **Memory curator** — the component that generates context packs, maintains the decision index, and drafts retrospectives from telemetry.
- **Owner** — the human; holds sole merge authority and ratifies decisions and high-risk plans. Not the transport between agents.

## Substrate

- **Forge** — the hosted git platform (GitHub is the reference; GitLab / Bitbucket / Gitea are equivalents behind a forge adapter).
- **Forge App** — the authenticated, scoped identity through which agents access the forge (short-lived tokens, per-agent, bot-attributed). Replaces long-lived personal access tokens.
- **Coordination bus** — the channel through which agents hand work to each other. **Tier 0** is forge-native (issues, comments, checks, committed event-log) and needs no external service; **Tier 1** is an opt-in low-latency adapter.
- **Adapter** — a swappable implementation behind a stable interface (`ForgeAdapter`, `AgentRuntime`, `CoordinationBus`, `DataStore`, `SurfaceHost`). The core depends on the interface, never the implementation.
- **`.quorum/`** — the git-native operational home: the committed, schema-validated files holding the task/decision graph, claim ledger of record, telemetry, and audit log.

## Artifacts

- **Task manifest** — the structured record of a unit of work: scope, risk tier, acceptance criteria, links.
- **Handoff** — a cross-agent or cross-session work-transition artifact recording current state for the receiver.
- **Review / finding** — a structured reviewer output; a finding has a severity and a verification status.
- **Claim** — an assertion by an agent about repository state (a file, a commit, an artifact) that the verifier checks.
- **Claim ledger** — the visible record of all claims in a change and their verification status (verified / unverifiable-but-disclosed / failed).
- **Decision (ADR)** — an architectural decision record; durable rationale for a direction.
- **Post-merge note (PMN)** — a cross-cycle learning captured after a change ships.
- **Retro** — a cycle retrospective, generated from telemetry and edited by a human.

## Concepts

- **Verify-before-assert** — the rule that claims about external state are checked before they count (principle 1).
- **Delivery vs effect** — a review can be *delivered* (the comment exists) while the *effect* it claims (a commit, a file) does not. Two separate verifications.
- **Three-endpoint poll** — reviewer output can land at any of three forge API surfaces (formal reviews, issue comments, line comments); all three must be polled.
- **Risk tier (T0–T4)** — how much blast radius a task carries; determines which gates and agents it must clear.
- **Autonomy tier (A0–A4)** — how much an agent may do without human ratification.
- **Three-factor isolation** — the security rule that no single agent context holds untrusted input, sensitive access, and state-change/egress at once (principle 12).
- **Fail closed / fail open** — safety-critical checks block on failure (closed); documentation-niceties allow on failure (open).
- **External-evidence bar** — a discipline promotes to canonical only on evidence from outside the pipeline that produced it (principle 10).
- **Delete-by-default** — every discipline carries a sunset trigger and is retired when it stops catching defects (principle 11).

## Architecture (ADR-0002 / ADR-0003)

- **Layer (L0–L4)** — Quorum's five-layer structure, split on the determinism line: **L0 Contracts** (schemas + protocol + skill I/O shape), **L1 Kernel** (deterministic verifier library + CLI), **L2 Gate** (the GitHub Action; the only layer that can block a merge), **L3 Skills** (agent participation packs; advisory only), **L4 Rationale** (principles, ADRs, docs).
- **Determinism line** — the boundary that decides what may gate: deterministic code may block a merge; an LLM agent may only propose, build, or review. The packaging boundary and the enforcement boundary are the same line.
- **Can-it-block-a-merge test** — the discriminator used to place each capability in a layer: enforcement lives only where deterministic code can gate.
- **Tier floor** — the minimum risk tier a diff is forced into by deterministic path rules, regardless of the tier an agent proposed; the Gate takes `max(proposed, floor)` so a high-blast-radius change cannot be re-graded downward.
- **Strict mode / salvage mode** — the Gate's two operating modes. *Strict*: structured claims are required at the task's tier and missing/failed claims fail closed. *Salvage*: no claims file is required; the kernel mines prose for action-claims and reports advisory results (fail open). Strict needs L3 skills or a disciplined agent; salvage works with neither.
- **Claim transport** — how claims reach the Gate: a committed append-only file `.quorum/claims/<task-id>.jsonl` (per-task files avoid concurrent-writer merge conflicts), with a fenced `quorum-claims` block in the PR body as a secondary source.
- **App-as-identity** — using a GitHub App only to mint short-lived, per-agent-scoped tokens from inside Actions runners (least-privilege identity, no personal access tokens), with **no hosted service**. Distinct from a **hosted App** (a webhook receiver / low-latency push service), which is a later opt-in upgrade.
- **Earned autonomy / automatic demotion** — an agent unlocks a higher autonomy tier only after N defect-free instrumented cycles at that grade, and is dropped one tier automatically when a post-merge defect is attributed to an auto-merged change.
- **Circuit breaker** — a deterministic halt that parks an unattended run for the human on a failed verification, an over-long fix loop, a mid-flight tier escalation, or any contact with enforcement machinery.
- **Untrusted-text quarantine** — the rule that an agent reading untrusted content never holds write access in the same context; it summarizes into a structured task file, and only that reaches write-capable agents (the operational form of principle 12 under autonomy).
- **Morning digest** — the single batched human-gate surface summarizing an unattended run (merged / queued / blocked + budget spent), rendered in the forge, sourced from the claim ledger.
- **Off-ramp artifact** — the standalone L1 kernel + CLI, which keeps working with no forge and no Quorum process, so an adopter who stops using Quorum keeps a usable verifier and their artifacts.
