# Quorum

**A multi-agent software-delivery framework where independent AI agents propose, review, and red-team work - and a human holds merge authority - coordinating through the repository instead of a human clipboard.**

> **Status: Phase 1 in progress - the verification kernel has shipped; enforcement (the Gate) is next.** The architecture is ratified (see [`docs/SPEC-PHASE-1.md`](docs/SPEC-PHASE-1.md) and the decisions in [`docs/adr/`](docs/adr/); founding decisions in [`docs/adr/ADR-0001-founding-decisions.md`](docs/adr/ADR-0001-founding-decisions.md)). Phase 1's **L0 contracts** and **L1 verification kernel** - the deterministic claim verifier plus the `quorum` CLI (`verify` / `tier` / `validate`) - shipped in QRM-1 (milestones M1+M2) and build and run from source today. The **L2 enforcement Gate** (a required status check) and **App-as-identity** are the next work (M3) and arrive via pull requests. This README describes the intended product so adopters share one picture; sections marked _(planned)_ or _specified, not yet built_ are not implemented and say so honestly. Quorum's predecessor failed by describing enforcement it had not shipped; this README is held to the inverse standard too - corrected to match what is actually on `main`.

---

## What problem Quorum solves

AI-assisted software work loses the truth. Agents claim actions that didn't happen ("I pushed that fix") and cite files and commits that don't exist. Chat context is ephemeral, so work doesn't survive a session. And when several AI tools collaborate, a human ends up copy-pasting artifacts between disconnected chat windows - losing context, introducing assumptions, and becoming a single-person bottleneck.

Quorum's answer:

- **Verify, don't trust.** Every agent claim about repository state is checked against actual state before it counts. The output is a visible claim ledger, not a leap of faith.
- **Coordinate through the repo, not a clipboard.** Agents share a common substrate - the git repository and the forge (GitHub and equivalents) - so they hand work to each other directly. The human ratifies and merges; the human is not the transport.
- **Cross-family review.** The agent that builds and the agent that reviews come from different model families, so correlated single-family failures get caught.
- **Ceremony scales with risk.** A typo and a schema migration do not travel the same pipeline. The lightweight path is the default.
- **Enforce in code, document in prose.** Rules that can be checked are shipped as checks, not described as discipline.
- **Learn with brakes.** Disciplines are promoted on outside evidence and retired when they stop catching defects. The framework can unlearn.

## What Quorum is not

- Not an operating system or a platform you build _on_. It is a governance overlay that rides on top of git, a forge, and swappable tools.
- Not vendor-locked. The required core is **git + a forge + TypeScript/Node + JSON Schema**. Databases, hosting, low-latency event buses, and agent runtimes are **optional adapters** you add only if a project needs them.
- Not a prompt pack. The value is the verification kernel and the coordination substrate, shipped as code.

## Required core vs optional adapters

| Layer | Status | Detail |
|---|---|---|
| git + forge (GitHub reference) | **required** | Source of truth; the only thing that can block a merge. Forge adapter abstracts GitLab / Bitbucket / Gitea. |
| TypeScript / Node | **required** | Reference runtime for Actions, CLI, adapters. |
| JSON Schema | **required** | Every structured artifact is schema-validated in CI. |
| `DataStore` adapter | _optional_ | Only for projects needing persistence or a large index. In-repo/SQLite default; Postgres / Supabase / Snowflake / Databricks / etc. |
| `SurfaceHost` adapter | _optional_ | Hosted dashboard beyond the forge's native PR surfaces. Vercel / Netlify / Cloudflare / self-hosted. |
| `CoordinationBus` Tier 1 | _optional_ | Low-latency push coordination for throughput-heavy projects. Forge-native (Tier 0) is the zero-dependency default. |
| `AgentRuntime` adapter | required-capability, pluggable | Claude / GPT-Codex / others. Builder and Reviewer must be different families. |

A small project runs the whole framework on nothing but a git repo and the forge.

## The agents (planned)

Professional roles, with beginner-facing labels in parentheses:

- **Architect (Planner)** - produces the task manifest and implementation contract.
- **Builder (Implementer)** - does the work on a branch, with scoped repo access via the forge App.
- **Reviewer (Checker)** - independent, cross-family; auto-invoked on every push.
- **Red-team** - adversarial pass on high-risk tasks.
- **Cross-review / critic** - model-family-independent critique of architectural decisions.
- **Verifier** - deterministic (not an LLM); extracts and checks claims, emits the ledger.
- **Memory curator** - context packs, decision index, generated retrospectives.
- **Human owner** - sole merge authority; ratifies decisions and high-risk plans.

## Status of components

| Component | Status |
|---|---|
| Governance principles | drafted ([`docs/PRINCIPLES.md`](docs/PRINCIPLES.md)) |
| Founding decisions (ADR-0001) | drafted |
| Architecture + build spec | **ratified** ([`docs/SPEC-PHASE-1.md`](docs/SPEC-PHASE-1.md); ADR-0002, ADR-0003). Original prompt retained as lineage ([`docs/SPEC-HANDOFF.md`](docs/SPEC-HANDOFF.md)) |
| Artifact schemas | **shipped** - QRM-1 M1: zod source of truth -> generated + committed JSON Schema + CI drift check ([`packages/contracts`](packages/contracts/)) |
| Verification kernel (claim verifier) | **shipped** - QRM-1 M2; Phase 1 flagship: extract / verify / ledger / tier-floor / diff-coverage ([`packages/kernel`](packages/kernel/)) |
| Adapter interfaces | **`ForgeAdapter` shipped** - LocalGitForge (offline), GitHubForge (Octokit), MemoryForge (fixtures). Other adapters Phase 2. |
| CLI / forge App | **CLI shipped** (`quorum verify` / `tier` / `validate`); **forge App (App-as-identity)** _specified, not yet built_ - M3 (ADR-0002) |
| Worked example | _placeholder_ ([`examples/`](examples/)) |
| Glossary | _stub_ ([`docs/GLOSSARY.md`](docs/GLOSSARY.md)) |

## Repository layout

```text
/
├-- README.md                  # this file
├-- LICENSE                    # MIT
├-- CONTRIBUTING.md            # how to contribute (stub)
├-- docs/
│   ├-- PRINCIPLES.md          # the 12 design principles (drafted)
│   ├-- GLOSSARY.md            # every term defined; generated-from-source eventually (stub)
│   ├-- SPEC-PHASE-1.md        # the ratified architecture + Phase 1 build spec
│   ├-- SPEC-HANDOFF.md        # original spec prompt (retained as lineage)
│   ├-- adr/                   # ADR-0001 founding - ADR-0002 packaging - ADR-0003 autonomy
│   ├-- decisions/             # lightweight / temporary decisions (TMP-*)
│   ├-- handoffs/              # cross-agent / cross-session work-transition artifacts
│   ├-- reviews/               # per-PR review-context records
│   └-- post-merge-notes/      # cross-cycle learnings
├-- .quorum/                   # git-native operational home: task/decision graph,
│                              #   claim ledger of record, telemetry, audit log
├-- schemas/                   # JSON Schema for every structured artifact (placeholder)
├-- examples/                  # complete worked-example project (placeholder)
└-- .github/
    ├-- workflows/             # ci.yml: build + test + drift (enforcement Gate Action lands in M3)
    └-- ISSUE_TEMPLATE/        # issue templates (none yet)
```

## Getting started

The kernel and CLI build and run from source today (Node 22+): `npm install`, `npm run build`, then `node packages/kernel/dist/cli.js verify --local --task <id>` on a feature branch. A packaged quickstart lands when Phase 1 completes (the M3 Gate). To follow the design: read [`docs/PRINCIPLES.md`](docs/PRINCIPLES.md), then [`docs/adr/ADR-0001-founding-decisions.md`](docs/adr/ADR-0001-founding-decisions.md), then the ratified architecture in [`docs/SPEC-PHASE-1.md`](docs/SPEC-PHASE-1.md) (with [`ADR-0002`](docs/adr/ADR-0002-packaging-and-layered-architecture.md) and [`ADR-0003`](docs/adr/ADR-0003-autonomy-and-risk-tiers.md)). A quickstart lands when Phase 1 ships.

## Lineage

Quorum is the ground-up successor to AMAS (`bryce-murphy/amas-framework`), which validated the core ideas - verification kernel, cross-family review, git-as-memory - and surfaced the failure modes Quorum is built to avoid: ceremony outrunning value, enforcement promised in prose but never shipped, a private vocabulary with no on-ramp, evidence that only confirmed itself, and a human relaying artifacts between disconnected agents. See [`docs/adr/ADR-0001-founding-decisions.md`](docs/adr/ADR-0001-founding-decisions.md) for what carried over and what was deliberately left behind.

## License

MIT - see [`LICENSE`](LICENSE).
