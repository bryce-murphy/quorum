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
