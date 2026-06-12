# ADR-0002 — Packaging and layered architecture

- **Status**: Accepted
- **Date**: 2026-06-12
- **Context**: architecture spec session (the §E packaging deliberation), owner-ratified
- **Amends**: ADR-0001 Decision 4 (clarifies and extends; does not overturn)
- **Superseded by**: none

## Status

Accepted — 2026-06-12. Records the packaging decision the spec session produced and the owner ratified. Phase 1 scope and the schemas/protocol that implement this decision are specified in `docs/SPEC-PHASE-1.md`.

## Context

ADR-0001 assumed, without deciding, that Quorum is "a framework." The spec session was explicitly authorized to decide the *form* before specifying internals. Three pure forms were on the table: a framework adopted wholesale, a set of portable agent skills, or a hosted forge App / control plane. The owner's stated interests (cross-vendor portability, a low adoption barrier, and safe unattended overnight operation) pull against any single pure form.

## Decision — five layers, split on the determinism line

Quorum is **layered**, and the layer boundary is the determinism line: **only deterministic code may block a merge; LLM agents propose, build, and review but never gate.** The packaging question and the "what can be trusted to enforce" question are the same question, so they get the same answer.

| Layer | What it is | May block a merge? | Vendor exposure |
|---|---|---|---|
| **L0 — Contracts** | JSON Schemas (claim, task manifest, ledger, policy) + the coordination protocol + the skill I/O shape | No — it is the parse target | None (open data contracts) |
| **L1 — Kernel** | Deterministic TS library + CLI: claim verification, three-endpoint poll, ledger emission, schema validation | No standalone — it is the engine | git + Node only; this is the off-ramp artifact |
| **L2 — Gate** | GitHub Action wrapping L1, wired as a required status check + tier-routed branch protection + App identity | **Yes — the only layer that may use the word "enforce"** | Forge-specific, behind `ForgeAdapter` |
| **L3 — Skills** | Agent participation packs (claim emission, handoff/review/red-team protocols), defined as capability + I/O contract, vendor bindings as adapters | Never — advisory by construction | Open shape is core; per-vendor bindings are adapters |
| **L4 — Rationale** | Principles, ADRs, glossary, adoption docs | No | None |

The discriminator across all packaging options was a single test — *can it actually block a bad merge, or only advise?* A pure-skills packaging fails it (a skill advises; overnight there is no human for advice to reach). A pure-framework packaging re-creates AMAS's adoption cliff. The layered model lets an adopter install **L2 alone** (which carries L0+L1) and get a claim ledger on every PR with no wholesale buy-in — the composability wedge both AMAS reviews named — while keeping enforcement real where it must be.

## Decision — amendment to ADR-0001 Decision 4

The required core remains **git + forge + TypeScript/Node + JSON Schema, and nothing else** as a *dependency* set. This ADR adds one item to the **open-contract surface** (not the dependency set): the **L3 skill interface shape** — capability + I/O contract. This is the same category as JSON Schema: an open shape the core defines, not a vendor the core depends on. Vendor skill *bindings* (Claude/GPT/Gemini/…) remain adapters. A Quorum repo still runs with zero skills installed (salvage mode), so Decision 4's "nothing else" guarantee on dependencies is intact. This is recorded as an amendment rather than left implicit because silent drift from a founding decision is the one prohibited move.

## Decision — App-as-identity for Phase 1

The GitHub App is used in Phase 1 purely as an **identity primitive**: its private key mints short-lived, per-agent-scoped installation tokens from inside Actions runners. This delivers least-privilege per-agent identity (principle 12) and the no-personal-access-token rule with **no hosted service**. The hosted App (webhook receiver, low-latency push) is a later, latency-justified upgrade, opt-in on the same logic as the `CoordinationBus` Tier 1 adapter.

## Consequences

- **Phase 1 scope** = L0 (claim + task-manifest schemas only) + L1 + L2 in dual mode (**strict**: structured claims required, fail closed; **salvage**: prose mining, advisory, fail open), demonstrated on a toy project with zero external services. Detailed in `docs/SPEC-PHASE-1.md`.
- **Repository shape** = monorepo (npm workspaces); L0/L1/L2 version in lockstep at this stage. Revisited when L3 vendor bindings ship.
- L3 skills and the remaining artifact schemas (handoff, finding, decision, retro; full-tier supersets) are Phase 2.
- The word "enforce" appears in exactly one layer's vocabulary (L2). Every other layer claims only what it can do (principle 2).

## Cross-references

- `docs/SPEC-PHASE-1.md` — the schemas, kernel surface, Gate, and Phase 1 build plan that implement this decision
- `docs/adr/ADR-0001-founding-decisions.md` — the founding decisions; Decision 4 amended here
- `docs/adr/ADR-0003-autonomy-and-risk-tiers.md` — the autonomy model that configures the L2 Gate
- `docs/PRINCIPLES.md` — principles 1, 2, 4, 7, 12
