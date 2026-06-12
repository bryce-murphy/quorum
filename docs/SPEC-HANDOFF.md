# Spec-the-Build Handoff — AMAS Successor (multi-agent delivery framework, ground-up)

**For**: a fresh Claude Fable 5 chat (architecture + spec surface)
**From**: the owner (Bryce) + outgoing Architect (Claude, Claude.ai), carrying the full AMAS reconciliation corpus
**Your job in this chat**: produce a complete, buildable architecture + phased spec for a **successor** to the AMAS framework — reimagined from the ground up, less ceremony, agent-native, installable. Ask clarifying questions where the spec is underdetermined; do not start writing code until the architecture is ratified. End with a repo scaffold plan and a phase-1 build spec concrete enough to hand to a builder agent.

---

## 0. TL;DR of what you're being asked to design

A **multi-agent software-delivery control plane** where distinct AI agents play distinct roles (Architect, Builder, Reviewer, Red-team, Cross-review/critic) and a human owner holds merge authority — but unlike its predecessor, the agents **share a common substrate (git repo + a state/event layer) instead of a human copy-pasting between chat windows.** The framework's job: make AI claims about repository state verifiable, make governance ceremony scale with risk (near-zero for a typo, heavy for a migration), enforce the rules *in code* rather than in prose, and learn across cycles without accreting forever. It must be adoptable by a small team and, eventually, by strangers.

The predecessor (AMAS) got the *ideas* right and the *packaging* wrong. Your design keeps the ideas, discards the packaging, and fixes the one architectural mistake that caused most of the pain: **the human-clipboard relay between disconnected AI surfaces.**

---

## 1. Full context — what AMAS was, and the evidence base you're inheriting

AMAS (`bryce-murphy/amas-framework`, public) was a self-dogfooding multi-role AI governance framework at v3.0.4 after ~50 cycles. It governed how multiple AI surfaces collaborate through defined roles: **Architect** (Claude.ai Project), **Builder** (Claude Code), **Reviewer** (Codex desktop pre-commit + GitHub App post-PR, both binding), **cross-Architect critic** (ChatGPT), **Owner** (human, sole merge authority, **manual relay between all surfaces**). No direct AI-to-AI communication — the owner relayed every artifact by hand.

It was reviewed in June 2026 by two independent architecturally-distinct model families (Claude and ChatGPT-pro), same skeptical 10-phase prompt, produced independently. Their convergence is the strongest non-adopter evidence available. The consolidated findings (treat each as confirmed unless your own analysis overturns it):

### 1.1. What was genuinely valuable (KEEP — this is the inherited asset)

- **The verification kernel.** "Delivery and effect are separate verifications." AI agents claim actions — "I created file X," "I pushed commit Y," "I filed issue Z" — and those claims routinely don't match repo state. AMAS's taxonomy of *how* claims fail is incident-derived and ahead of the published provenance standards (SLSA/in-toto):
  - **Sub-shape A — fully fabricated claim**: cited commit SHA doesn't resolve, cited file doesn't exist.
  - **Sub-shape B — correct content, fabricated citation**: the finding is substantively right but the cited SHA is unreachable; the finding is still real, only the citation is phantom.
  - **Three-endpoint review polling**: AI reviewer output lands unpredictably across three GitHub API surfaces (formal PR reviews, issue comments, line comments) — you must poll all three, with a lexicographic timestamp+id tie-break to avoid dropping same-second emissions.
  - **Post-handback five-point check**: when a builder hands back, the receiver re-verifies (poll reviewer output, branch tip SHA, file content vs claim, phantom-action audit, comment-content claims).
- **Cross-ecosystem reviewer independence.** Builder and Reviewer on *different model families*, so correlated single-family failure modes get caught. Both reviews called this the single most defensible structural rule. **Non-negotiable in the successor.**
- **Git as durable memory.** Chat context is ephemeral; if it isn't in the repo it doesn't exist. Correct — but the successor adds a machine-state layer *alongside* git (see §3).
- **Risk-tiered thinking** (designed but never shipped as behavior): autonomy tiers A0–A4, task-risk tiers T0–T4.
- **The learning loop**: observe → record → promote → canonicalize → enforce.

### 1.2. What went wrong (FIX — these are the anti-requirements)

- **Ceremony outran value.** A uniform pipeline priced a typo at the cost of a schema migration (estimated 4:1 to 10:1 ceremony:value for adopters). The successor **must tier ceremony from commit one** — lite path is the default, not "forthcoming."
- **Enforcement was prose, not code.** The tagline promised "deterministic enforcement via Actions"; 7 of 9 Actions were stubs. Every "checkable predicate" was a manual ritual executed by the same LLMs the framework distrusts. **The successor enforces in code or doesn't claim enforcement.**
- **Private language / no on-ramp.** A dense self-referential citation graph — (XXIV.a-n), (i.5), path-(α'), M-A7, MC-C — with no glossary, no worked example, no quickstart. Beginner accessibility graded 2-3/10. **The successor is glossary-first, example-first, ≤2k-token agent law with progressive disclosure.**
- **Self-confirming evidence loop.** All promotion evidence came from the one pipeline evaluating itself — n=1 operator, one project. 3+ "confirmations" were not independent samples. **The successor requires external evidence to promote a discipline (outcome metric, cross-domain data, or external adopter), and adopts delete-by-default sunset reviews so it can unlearn.**
- **Markdown-as-everything.** Prose was the parse target for automation, maintained by LLM diligence — fragile. **The successor uses schema-validated structured artifacts with rendered Markdown views.**
- **THE BIG ONE — the human-clipboard relay.** Claude.ai had no direct GitHub access, so it made assumptions about repo state and drifted. Context was lost copy-pasting across Claude / Codex / ChatGPT. The owner was a serialization bottleneck (bus factor 1). **The successor's agents share a substrate; the human ratifies, doesn't relay.**

### 1.3. The three-year target both reviews converged on

Not "a better set of templates." An **AI software delivery control plane**: installable GitHub App + Actions + CLI, a claim verifier, a context-pack generator, a task/decision graph, an audit ledger, a policy engine, a human approval surface. The successor is the deliberate, ground-up build of that target.

---

## 2. Design principles for the successor (the spine — hold these unless analysis overturns them)

1. **Verify, don't trust.** Every agent claim about external state is unverified until checked mechanically. (Inherited; correct.)
2. **Enforce in code, document in prose.** Any rule stated twice becomes a schema/lint/Action. Prose that could be a check is debt.
3. **Risk-tiered ceremony from day one.** Process weight scales with blast radius. Lite is the default path; heavy tiers are opt-in. Tiering ships in v0.1, not "later."
4. **Shared substrate, not a human relay.** Agents communicate through the repo + a state/event layer with direct, scoped access. The human is the accountability gate, not the transport.
5. **Git is the source of truth; any external store is an optional operational cache.** Canonical, diff-reviewable truth stays in git (preserves owner-ratification-by-diff). The task/decision graph, claim ledger of record, telemetry, and audit log have a git-native home by default; an external store (when a project opts into one) holds a derived event bus / index / cache — never the canonical record, and never a core dependency.
6. **Machine-first artifacts, human-readable views.** Handoffs, reviews, decisions are structured data validated in CI; Markdown is a rendered view, not the store.
7. **Cross-family review, always.** Builder and Reviewer on different model lineages. Independence matters *more* as human relay decreases.
8. **Token budgets are architecture.** Agent-facing law fits in ≤2k tokens with progressive disclosure. If an agent must read 50k tokens to fix a typo, the law is wrong.
9. **Generated ceremony.** Agents and humans never hand-author boilerplate; scaffolding emits conformant artifacts, so conformance is free.
10. **External evidence or it didn't happen.** Disciplines promote on measured outcomes, cross-domain data, or external adopters — not the pipeline confirming itself.
11. **Delete by default.** Every discipline carries a sunset trigger; ceremony that catches no defect in N instrumented cycles is removed. A learning loop must be able to unlearn.
12. **Security is a first-class axis, agent-native.** Agents process untrusted content (issue/PR/comment bodies, fork diffs, tool output) with tool access — the live prompt-injection / secret-exfiltration attack surface (documented against agentic CI in 2026). Adopt the three-factor isolation rule (no single agent context holds untrusted-input + sensitive-access + state-change/egress simultaneously) + least-privilege per-agent identity + circuit-breakers that fail to the human. Fail closed for safety-critical claims, fail open for documentation niceties.

---

## 3. Recommended architecture (the owner has pre-ratified this direction; pressure-test it, don't rubber-stamp)

### 3.1. The substrate (this is the core reimagining) — git-native, vendor-portable

**Hard rule: the core depends ONLY on git + a hosted forge (GitHub reference; GitLab/Bitbucket/Gitea as equivalents behind a forge adapter). No database, no hosting vendor, and no specific agent runtime is a core dependency.** Everything beyond git+forge is an **optional adapter** plugged in behind a stable interface, used only by projects that need it. A small docs/code project must run the full framework with nothing but a git repo and the forge's CI + App — zero external services.

Three layers, each with a clear ownership boundary:

- **Source-of-truth layer — the git repo (REQUIRED, the only required substrate).** Code, canonical config, schemas, decisions (ADR-equivalents), structured artifacts, and their rendered views. Diff-reviewable; the owner ratifies by reading diffs. *Nothing canonical lives anywhere but git.* The task/decision graph, the claim ledger of record, and the audit trail all have a **git-native default home** (structured files committed to the repo, e.g. under a `.<name>/` directory, validated by schema in CI). This is the floor that always works.

- **Coordination layer — the shared agent substrate that replaces the human clipboard (REQUIRED capability, pluggable implementation).** Agents post artifacts, findings, and handoffs that other agents consume — direct agent-to-agent flow, owner-observable, owner-gated at merge. This is the dissolution of the copy-paste problem and it must work **without any external service** in the default tier. The capability is defined by an interface (a `CoordinationBus` / `EventStore`), with a tiered implementation ladder:
  - **Tier 0 (default, zero-dependency): forge-native.** The bus is the forge itself — Issues/PR comments/commit statuses/Actions artifacts/a committed event-log file, polled or webhook-driven. Agents coordinate through GitHub (or the forge adapter) and nothing else. Slower and coarser, but no external dependency and fully portable.
  - **Tier 1 (opt-in, low-latency): a realtime/event service adapter** for projects that want push-based, low-latency multi-agent coordination (e.g. a hosted Postgres+Realtime such as Supabase, a queue, a durable-object service, or an existing warehouse the adopter already runs — Snowflake/Databricks/etc.). This is an **add-on for data/throughput-heavy projects only**, never a requirement.
  - Either way, the **canonical record of what was decided/claimed is reconciled back into git** (the bus is transport + operational cache; git is truth). An external store is a derived index and event cache, never the source of truth.

- **Execution/enforcement layer — forge App + CI Actions + a CLI (REQUIRED capability, forge-adapter-backed).** Where deterministic gates run — the only layer that can actually block a merge. Claim verifier, review-freshness, branch/PR checks, surface generation. The App is the agents' authenticated, scoped forge access — *no agent assumes repo state; it queries through the App.* GitHub App is the reference; the forge adapter abstracts the equivalent on other forges.

**Optional adapters (used only when a project needs them; none is a core dependency):**
- **Data store** — for projects whose *product* needs persistence, or that want the Tier-1 low-latency bus / a large embedding-backed decision index. Behind a `DataStore` interface; reference adapter is Supabase/Postgres, but any Postgres, a warehouse (Snowflake, Databricks), or SQLite-in-repo satisfies it. **Add-on, not requirement.**
- **Human-surface host** — for the approval dashboard / claim-ledger viewer / decision-graph browser, *if* a project wants a hosted UI beyond the forge's native PR surfaces. Behind a deploy adapter; reference is Vercel, but any host (or none — the forge PR surface is the zero-dependency default) works.
- **Agent runtime** — behind an `AgentRuntime` adapter; Claude / GPT-Codex / others. Builder and Reviewer must be different families.

**Why git-as-truth and store-as-optional-adapter (not DB-as-truth):** a DB-as-canonical-source destroys the diff-reviewable property the framework exists to protect, reintroduces a render-sync problem, AND hard-wires a vendor into the core — the exact lock-in AMAS's successor must avoid. Keeping truth in git means the framework runs anywhere git runs; the store, the host, and the runtime are swappable because something better will exist in two years. This is the corrected version of the reviews' "machine-readable state store" recommendation: machine-readable, yes — but in git by default, in an external store only as an opt-in operational cache.

### 3.2. The agents (event-driven participants, not chat personas)

Keep the professional role model; expose **beginner-facing labels** (Planner / Implementer / Checker) over it. Roles as substrate participants:

- **Architect / Planner** — produces the task manifest + implementation contract; invoked per-task, not a standing chat.
- **Builder / Implementer** — works on a branch with automatic session capture; direct scoped repo access via the App.
- **Reviewer / Checker** — independent, cross-family; auto-invoked on every push (the Action AMAS specified and never shipped).
- **Red-team** — adversarial pass on T3+ tasks (security-sensitive, irreversible); the security axis given teeth.
- **Cross-review / critic** — model-family-independent critique of Architect-class and ADR-class decisions; the independent-evidence anchor.
- **Verifier (machine, not LLM)** — the claim-extraction + claim-checking Action; deterministic.
- **Memory curator** — context-pack generation, decision-index maintenance, retro drafting from telemetry.
- **Human owner** — sole merge authority, ratifies decisions and high-risk plans, reads the claim-ledger verdict. Not the transport.

Agents coordinate through the §3.1 coordination layer (forge-native by default, low-latency adapter opt-in); the human observes the coordination surface and gates at merge. **This is the dissolution of the copy-paste problem — design it explicitly, and design it to work with zero external services first.**

### 3.3. Stack — required core vs swappable adapters

The dividing line is the whole point: **the core is small, portable, and vendor-free; everything vendor-specific sits behind an adapter interface so it can be replaced when something better ships.** AMAS's successor must not bind a vendor into the core the way this section could be misread to.

**Required core (every adopter, no exceptions):**
- **git + a hosted forge.** GitHub is the reference implementation; the forge adapter abstracts GitLab / Bitbucket / Gitea / Forgejo equivalents. The forge App (short-lived scoped tokens, bot-attributed identity, the noreply-email pattern — never long-lived user PATs) is the agents' authenticated access and the only thing that can block a merge.
- **TypeScript / Node** as the reference runtime for the Actions, CLI, and adapter interfaces — chosen because it is forge-Actions-native (`@actions/*` is TS-first) and the dominant App-ecosystem language, so the tooling is maximally portable across adopters' CI. (A core *could* be polyglot; TS is the recommended single reference so adopters share one toolchain. Argue this in §4.1 if you disagree.)
- **Schemas** for every structured artifact — JSON Schema with a TS/Zod reference validator — validated in CI. Schemas are core; the *validator implementation* is replaceable.
- **A git-native home** for the task/decision graph, claim ledger of record, telemetry, and audit log (committed structured files under `.<name>/`, schema-validated). This is the always-works default; an external store only ever caches/indexes it.

**Swappable adapters (interfaces are core; implementations are not — adopt only what a project needs):**
- **`ForgeAdapter`** — GitHub (reference) | GitLab | Bitbucket | Gitea/Forgejo. Abstracts PR/issue/review/check APIs and App identity.
- **`AgentRuntime`** — Claude (Anthropic) | GPT/Codex (OpenAI) | others. Vendor-neutral; A2A Agent-Card shape where cheap, no transport lock-in. **Builder and Reviewer must be different families.**
- **`CoordinationBus`** — forge-native Tier 0 (default, zero-dependency) | realtime/queue/durable-object/warehouse Tier 1 (opt-in). Supabase Realtime is *a* reference Tier-1 adapter, not the bus.
- **`DataStore`** (optional, only for data-needing projects) — in-repo files/SQLite (default) | Postgres / Supabase | Snowflake | Databricks | any warehouse the adopter already runs. The framework writes through the interface; the adopter picks the implementation, or uses none.
- **`SurfaceHost`** (optional) — the forge's native PR/issue surfaces (default, zero-dependency) | a hosted dashboard on Vercel | Netlify | Cloudflare | self-hosted, for adopters who want a richer human-approval/claim-ledger/decision-graph UI.
- **Provenance (future, optional)** — in-toto / SLSA / Sigstore attestations for build artifacts + a custom review-predicate for semantic claims. Forward-compatible from v0.1; adopted at maturity, never a v0.1 dependency.

**Owner's reference choices for *his own* projects (NOT framework requirements):** the owner will commonly run the `DataStore` adapter on **Supabase** and the `SurfaceHost` adapter on **Vercel** for projects that need persistence and a hosted UI — because that's his stack, not because the framework cares. The framework must run identically for an adopter on Databricks + Cloudflare, or on nothing but GitHub. **Fable 5: treat Supabase and Vercel as worked examples of two adapter slots, never as architecture.**

### 3.4. Name slate (pick one; my recommendation first)

- **Relay** — names the thing it fixes (the broken human relay becomes an automated one). Short, ownable, `relay.dev`-adjacent. **Recommended.**
- **Loop** — the verified learning loop, observe→enforce. Risk: generic.
- **Provenance / Prov** — names the asset (claim verification + audit). Risk: overlaps SLSA vocabulary.
- **Quorum** — multi-agent consensus + human gate. Evocative; slightly heavy.
- **Lattice** — the layered substrate. Risk: used elsewhere.

Use a placeholder `<NAME>` in the spec until the owner picks.

---

## 4. What I need you (Fable 5) to produce in this chat

Work in this order; stop for ratification between major sections.

1. **Pressure-test §3.** Where is the recommended architecture wrong, risky, or over-built for a small team? Name the top 3 risks and your mitigations. Specifically interrogate the **coordination layer**: is the Tier-0 forge-native default (Issues/PR comments/checks/Actions artifacts/committed event-log as the agent bus) actually sufficient for multi-agent coordination, or does latency/ordering force a Tier-1 adapter sooner than claimed? And confirm the **git-native default home** for the claim ledger / decision graph / telemetry is workable at small scale before any external store is introduced. Argue both. (The owner has ruled that no external store — Supabase or otherwise — may be a core dependency; it is an opt-in adapter for data-needing projects only. Design within that constraint.)
2. **The agent-communication protocol.** Concretely: how does the Architect agent hand a task to the Builder agent through the substrate without a human in the loop, while the human still gates merge? Define the message schema, the subscription model, the state machine for a task moving Planner→Implementer→Checker→Red-team→human-merge, and how an agent *queries verified repo state* (via the App) instead of assuming it. This is the heart of the design.
3. **The structured-artifact schemas.** Define JSON Schema/Zod for: task manifest, handoff, review/finding, claim, decision (ADR-equivalent), retro. Each with a rendered-Markdown view. Show the lite-tier minimal subset vs the full-tier superset of each.
4. **The risk-tiering model.** T0–T4 task tiers and A0–A4 autonomy tiers, and exactly which gates/agents each tier invokes. The lite (T0/T1) path must be genuinely lightweight — a typo should traverse near-zero ceremony. Show the routing table.
5. **The verification kernel as code.** Spec the claim-extraction + claim-verification Action: how claims are parsed from agent output and PR/commit/comment text, how each claim category is checked against repo state via the App, and the claim-ledger output contract (the "N claims, N verified…" PR summary). This is the flagship demoable slice — sequence it to ship first.
6. **The learning loop with brakes.** How observations promote to disciplines (external-evidence bar), how disciplines sunset (delete-by-default trigger keyed to telemetry catch-attribution), where the decision index lives, and how retros are generated-then-edited rather than hand-authored.
7. **The adoption layer, designed in from commit one.** Glossary (generated from source term definitions), ≤2-page quickstart, a complete worked-example repo (kickoff → 3 cycles, every artifact filled), CONTRIBUTING, an honest "what this costs" page by tier, beginner role labels, and an explicit off-ramp ("if you stop using <NAME>, you keep your repo, your artifacts, and the verifier"). AMAS shipped none of this; it's why nobody adopted it.
8. **Security model, agent-native.** Operationalize principle 12: three-factor isolation, per-agent least-privilege identity via the forge App (scoped installation tokens per agent; the always-available identity primitive — *not* dependent on any DB), untrusted-content handling on the coordination layer, circuit-breakers that fail to the human, fail-closed/fail-open taxonomy per check. Where a Tier-1 store adapter is in use, its access controls (e.g. row-level security on a Postgres/Supabase adapter) are an *additional* enforcement surface, not the primary one. Address the coordination layer itself as an attack surface (a poisoned artifact crossing agent-to-agent) under both Tier-0 forge-native and Tier-1 adapter implementations.
9. **The adapter interface layer (the portability mechanism).** Define the stable interfaces that keep the core vendor-free: `ForgeAdapter`, `AgentRuntime`, `CoordinationBus`, `DataStore`, `SurfaceHost`. For each: the minimal method surface, the conformance contract a new implementation must satisfy, and the zero-dependency default implementation. Show that the full framework runs with only the forge-native defaults (no `DataStore`, no `SurfaceHost`, no Tier-1 bus) — then show what plugging in one adapter (e.g. a Postgres `DataStore`) adds. This is what makes "something better in two years" a config change, not a rewrite.
10. **Repo scaffold + phased build plan.** The directory layout, the monorepo-vs-not call, and a phase sequence where **Phase 1 ships a working vertical slice** (the forge App + the claim-verifier Action + the minimal task→PR→verify→human-merge loop on a real toy project, running on forge-native defaults with zero external services) rather than a pile of specs. Then Phase 2+ adds agents, tiers, learning loop, optional adapters, adoption layer.
11. **Migration note.** How `upcds` (the downstream AMAS adopter project) and AMAS's own incident corpus migrate onto <NAME>. What carries over (the verification kernel, the incident taxonomy as test cases, the decision history), what's abandoned (the citation-graph vocabulary, manual ceremony).

---

## 5. Constraints + non-negotiables

- **Cross-family Builder/Reviewer independence** survives. Always.
- **Git stays the source of truth.** Any external store is an optional, opt-in operational cache/index — never canonical, never a core dependency. Do not invert this.
- **Human holds merge authority** through at least the equivalent of A2; auto-merge is data-gated and earned, never default.
- **Lite path is the default**, heavy tiers opt-in. A small team must get value in the first hour.
- **Enforce in code.** If the spec describes a "checkable predicate," there must be a plan to ship the checker — no manual-ritual predicates.
- **Glossary-first, example-first, ≤2k-token agent law.** No private vocabulary without a generated definition.
- **External-evidence bar + delete-by-default** baked into the learning loop from the start.
- **Initial users**: the owner + a small team, but designed for external adopters from commit one (public repo, real README, real onboarding). This is explicitly *not* another n=1 dogfood-only artifact.
- **Stack**: required core is **git + a forge (GitHub reference) + TypeScript/Node + JSON-Schema** and nothing else. Data store (Supabase/Postgres/Snowflake/Databricks/SQLite), surface host (Vercel/Netlify/Cloudflare/self-hosted), coordination Tier-1 service, and agent runtime are all **swappable adapters behind interfaces** — adopt only what a project needs. The framework must run on nothing but a git repo + the forge. Argue any change to the *required core* in §4.1; the adapter implementations are deliberately open.

## 6. Operating posture for this chat

- The owner communicates in terse signals; surface genuine decision points with **firm recommendations**, not option menus.
- Pressure-test the inherited recommendations — the owner explicitly wants this *better* than AMAS, not a re-skin. If something in §2/§3 is wrong, say so and argue it.
- Don't reproduce AMAS's failure in microcosm: keep *this spec* lean. Progressive disclosure applies to your own output — lead with the architecture and the phase-1 slice; defer exhaustive schema enumeration to an appendix.
- End the session with: (a) ratified architecture, (b) the phase-1 vertical-slice build spec concrete enough for a builder agent, (c) the repo scaffold, (d) open questions for the owner.

## 7. Opening move

Start by either (a) confirming you'll adopt the §2 principles and §3 architecture and going straight to §4.1 pressure-test, or (b) naming the single biggest thing you'd change about the recommended architecture before we proceed. Then ask the owner any clarifying questions that materially change the design. Do not write code until the architecture is ratified.
