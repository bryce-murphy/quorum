# ADR-0003 — Risk tiers, tier floor, and the autonomy model

- **Status**: Accepted
- **Date**: 2026-06-12
- **Context**: the autonomy / unattended-operation axis (spec packet §F), owner-ratified
- **Supersedes**: none
- **Superseded by**: none

## Status

Accepted — 2026-06-12. Records the risk-tier and autonomy model. The model is ratified in full; Phase 1 implements only the parts noted under Consequences (the rest is Phase 2, but the design is fixed now so nothing is retrofitted).

## Context

Quorum must support agents working unattended — e.g. overnight — with checks and balances. When no human is awake to ratify, the only thing between an agent and a bad merge is a gate that cannot be talked out of its verdict. That makes the risk/autonomy model a core safety control, not a later feature. AMAS designed A0–A4 / T0–T4 tiers but never made them operational and never bounded unattended spend.

## Decision — risk tiers T0–T4, with a code-enforced floor

| Tier | Meaning | Examples |
|---|---|---|
| **T0** | Cosmetic; cannot change behavior | typo, comment, formatting |
| **T1** | Contained, tested, trivially reversible | isolated function + test |
| **T2** | Standard work (the default) | multi-file feature |
| **T3** | High blast radius | schema/migration, security-touching, new dependency, **any change to Quorum's own enforcement machinery** |
| **T4** | Irreversible / external | data deletion, releases, secrets |

The Planner (an LLM) *proposes* a tier; the Gate (deterministic) computes a **floor** from the diff and takes `max(proposed, floor)`. Tiers raise freely and never lower below the floor — no agent can re-grade a migration as a typo. Floor rules are path-based, declared in `.quorum/policy.yml`, and land with the Gate (Phase 1 M3). Initial floors: enforcement machinery, workflows, schemas, policy, lockfiles, and migration/IaC paths → T3 minimum.

## Decision — autonomy tiers A0–A4

A1 is the starting posture. **T3 and T4 never auto-merge at any autonomy level — this is a hard ceiling.**

| | T0 | T1 | T2 | T3 | T4 |
|---|---|---|---|---|---|
| **A0** | human | human | human | human | human |
| **A1** (start) | human | human | human | human | human |
| **A2** | auto on green | human | human | human | human |
| **A3** | auto | auto on green + Reviewer ✓ | human | human | human |
| **A4** | auto | auto | auto on green + Reviewer ✓ + Red-team ✓ | human | human |

Autonomy is **earned and revocable**. Promotion requires N defect-free instrumented cycles at the candidate grade (N configurable, default 10). Demotion is automatic: any post-merge defect attributed to an auto-merged change drops the level by one and posts the reason. The loop cannot quietly become overconfident.

## Decision — overnight mechanics

- **Budgets** (token / wall-clock / task-count) per unattended run, with **stop-and-queue** semantics — never push through a limit.
- **Circuit breakers** halt the run and park everything for the human on: a failed verification, a build→review→fix loop exceeding 3 rounds, a mid-flight tier escalation, or any contact with enforcement machinery.
- **Untrusted-text quarantine** (principle 12): the agent that reads untrusted content (issue/PR bodies, fork diffs) never holds write access in the same context; it summarizes into a structured task file, and only that reaches write-capable agents. Fork PRs never run with write access or secrets.
- **Morning digest**: unattended work accumulates as a single batched human-gate surface — "Overnight: 14 tasks. 11 merged on green. 2 queued for your call. 1 blocked + reason. 60% of budget spent" — rendered in the forge, nothing extra to host. The claim ledger is its data source.
- **Reversibility**: every auto-merged change must be one-command reversible; anything that cannot promise a clean undo is graded T2+ and therefore waits for a human anyway.

## Consequences

- **Phase 1 hard-codes A1**: the Verifier runs on everything, the human merges everything. The matrix above constrains the design but requires no promotion/demotion machinery yet.
- The A-tier permissions are expressed as L2 Gate configurations (ADR-0002), not as separate infrastructure.
- The claim ledger and task manifest (`docs/SPEC-PHASE-1.md` §3) are designed so the morning digest and budget/telemetry surfaces (Phase 2) read from them without retrofitting.
- "Would this be safe to run unattended overnight?" is a standing test every later design increment must pass.

## Cross-references

- `docs/adr/ADR-0002-packaging-and-layered-architecture.md` — the L2 Gate that these tiers configure
- `docs/SPEC-PHASE-1.md` — the claim/manifest schemas and the tier-floor implementation slice
- `docs/PRINCIPLES.md` — principles 3 (risk-tiered ceremony), 7 (cross-family review), 12 (security)
