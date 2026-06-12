# ADR-0001 — Founding decisions

- **Status**: Accepted
- **Date**: 2026-06-11
- **Context**: project inception (Quorum bootstrap, successor to AMAS)
- **Supersedes**: none
- **Superseded by**: none
- **Amended by**: ADR-0002 (Decision 4 — clarifies that the skill interface shape joins the open-contract surface; the dependency guarantee is unchanged)

## Status

Accepted — 2026-06-11. Records the decisions made at project inception, before the architecture spec session. Some decisions here are deliberately provisional and flagged as open to the spec session (`docs/SPEC-HANDOFF.md`); those are noted inline. Architectural specifics the spec session produces will land as ADR-0002 onward.

## Context

Quorum is the ground-up successor to AMAS (`bryce-murphy/amas-framework`), a self-dogfooding multi-role AI governance framework that reached v3.0.4 over roughly fifty cycles. AMAS was reviewed in June 2026 by two architecturally distinct AI model families running the same skeptical review prompt independently; their convergent findings are the strongest evidence available short of external adopters. The reviews agreed: the core ideas were right and ahead of the field, but the packaging caused the framework to be effectively unadoptable by anyone except its author.

This ADR records what Quorum carries forward, what it deliberately abandons, and the founding architectural commitments — so future readers (and the spec session) understand the reasoning at inception rather than reconstructing it.

## Decision 1 — Quorum is a successor, not a refactor

AMAS is not migrated or patched; Quorum is built ground-up. AMAS remains as lineage and as a source of incident data (its documented claim-fabrication taxonomy becomes test fixtures for Quorum's verifier). The downstream AMAS adopter project `upcds` migrates onto Quorum once Phase 1 ships. AMAS itself is wound down rather than maintained in parallel.

## Decision 2 — Carry forward the verification kernel as the asset

The single most valuable thing inherited from AMAS is the verification kernel: the delivery-vs-effect distinction, the claim-fabrication sub-shape taxonomy (fully fabricated vs correct-content-fabricated-citation), three-endpoint review polling with a timestamp+id tie-break, and the post-handback verification check. This is incident-derived and ahead of the published provenance standards. It is Quorum's flagship and ships first (Phase 1).

## Decision 3 — Keep cross-family reviewer independence as a hard rule

The agent that builds and the agent that reviews come from different model families. Both AMAS reviews independently named this the most defensible structural rule. It is non-negotiable in Quorum.

## Decision 4 — The required core is git + forge + TypeScript/Node + JSON Schema, and nothing else

No database, no hosting vendor, no specific agent runtime is a core dependency. A small project must run the full framework on nothing but a git repository and a forge (GitHub is the reference; GitLab / Bitbucket / Gitea sit behind a forge adapter). Everything vendor-specific — data store, surface host, low-latency coordination bus, agent runtime — sits behind a stable adapter interface and is adopted only when a project needs it. This is the deliberate correction of AMAS's drift toward implied platform-hood, and it ensures Quorum survives the inevitable churn of any single vendor. _(The exact adapter interfaces are specified by the spec session; this decision fixes only that they exist and that the core stays vendor-free.)_

## Decision 5 — Git is the source of truth; external stores are optional operational caches

Canonical, diff-reviewable truth lives in git (preserving owner-ratification-by-diff). The task/decision graph, claim ledger of record, telemetry, and audit log have a git-native default home under `.quorum/`. An external store, when a project opts into one, is a derived index or event cache — never canonical. This rejects the "machine-readable state store as source of truth" option one review proposed, on the grounds that it would destroy diff-reviewability and reintroduce vendor lock-in.

## Decision 6 — Agents coordinate through a shared substrate, not a human clipboard

AMAS's worst structural flaw was the human owner manually relaying artifacts between disconnected AI surfaces (Claude.ai had no repo access and made assumptions; context was lost across copy-paste; the owner was a serialization bottleneck). Quorum's agents coordinate through the repository and forge directly. The default coordination bus is forge-native and requires zero external services; a low-latency adapter is opt-in. The human observes the coordination surface and gates at merge; the human is not the transport. _(The coordination protocol and state machine are specified by the spec session.)_

## Decision 7 — Ceremony is risk-tiered from v0.1; enforcement is code, not prose

Process weight scales with blast radius, with the lightweight path as default — not a "forthcoming lite tier." Any rule that can be checked ships as a check; Quorum does not document enforcement it has not shipped. This directly answers AMAS's two most-cited defects (uniform pipeline cost, and enforcement promised in prose but left as stubs).

## Decision 8 — The learning loop has brakes: external-evidence bar and delete-by-default

Disciplines promote to canonical only on evidence from outside the producing pipeline (outcome metric, cross-domain data, or external adopter; independent cross-model review is second-tier). Every discipline carries a sunset trigger and is retired when it stops catching defects. This answers AMAS's self-confirming evidence loop and its monotonic accretion.

## Decision 9 — Adoption layer is designed in from commit one

Glossary (eventually generated from source), a short quickstart, a complete worked example, contribution guidelines, an honest cost-by-tier page, beginner role labels (Planner / Implementer / Checker), and an explicit off-ramp. AMAS shipped none of these and had zero external adopters; Quorum treats them as load-bearing, not optional polish.

## Decision 10 — Name and license

The project is named **Quorum** — a quorum is the minimum set of independent participants whose agreement is required to act, which is precisely the multi-agent-plus-human-gate model. Licensed MIT for broad adoption.

## Alternatives considered

- **Refactor AMAS in place.** Rejected: the vocabulary debt and ceremony debt were structural; a refactor would inherit them. Ground-up is cheaper than untangling.
- **Machine-readable state store (JSON/SQLite) as source of truth.** Rejected per Decision 5: destroys diff-reviewability and reintroduces lock-in.
- **Bake in a specific stack (e.g. Supabase + Vercel).** Rejected per Decision 4: hard-wiring a vendor into the core is the exact failure being corrected; these are adapter implementations, not architecture.
- **Keep the AMAS role vocabulary.** Rejected: the private citation-graph vocabulary was a primary adoption blocker. Professional role names with beginner-facing labels replace it.

## Consequences

- The architecture spec session (`docs/SPEC-HANDOFF.md`) operates within these decisions; it specifies the adapter interfaces, coordination protocol, artifact schemas, tiering model, and the Phase 1 verification-kernel slice, but does not relitigate Decisions 1–10.
- Subsequent ADRs (ADR-0002+) record the spec session's architectural choices.
- `upcds` migration and AMAS wind-down are sequenced after Phase 1 ships a working verification kernel.

## Cross-references

- `docs/PRINCIPLES.md` — the twelve design principles these decisions instantiate
- `docs/SPEC-HANDOFF.md` — the architecture spec prompt operating within these decisions
- `docs/GLOSSARY.md` — term definitions
- AMAS (`bryce-murphy/amas-framework`) — lineage and incident-data source
