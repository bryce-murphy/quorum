# Quorum — Ratified Architecture & Phase 1 Build Spec

- **Status**: Ratified by owner, 2026-06-12 (packaging + autonomy model + this spec's scope)
- **Supersedes**: the framework-shaped draft in `docs/SPEC-HANDOFF.md` (retained as lineage)
- **Feeds**: ADR-0002 (packaging + Decision-4 amendment), ADR-0003 (autonomy model)
- **Scope of this document**: everything a Builder agent needs to ship Phase 1. Phase 2+ material appears only where a Phase 1 choice constrains it.

---

## 1. Ratified architecture (summary of record)

### 1.1 Five layers, split on the determinism line

Only deterministic code may block a merge. LLM agents propose, build, and review; code gates.

| Layer | What it is | May block a merge? |
|---|---|---|
| **L0 Contracts** | JSON Schemas + protocol definitions (this doc §3) | No (parse target) |
| **L1 Kernel** | Deterministic TS library + CLI: claim verification, ledger emission | No (the engine) |
| **L2 Gate** | GitHub Action wrapping L1, wired as required status checks | **Yes — only this layer enforces** |
| **L3 Skills** | Agent participation packs (open shape, vendor bindings as adapters) | Never (Phase 2) |
| **L4 Rationale** | Principles, ADRs, glossary, adoption docs | No |

- **ADR-0001 Decision 4 amendment (ratified)**: the L3 skill interface shape (capability + I/O contract) joins the open contract surface. Vendor bindings remain adapters. No new core dependency.
- **App-as-identity (ratified)**: Phase 1 uses a GitHub App registration purely as an identity primitive — its private key mints short-lived, scoped installation tokens from inside Actions runners. No hosted service. The hosted App is a later, latency-justified upgrade.
- **Phase 1 ships L0 (claim + task-manifest schemas) + L1 + L2 dual-mode** on a demo project, zero external services.

### 1.2 Risk tiers T0–T4 (ratified)

| Tier | Meaning | Examples |
|---|---|---|
| T0 | Cosmetic; cannot change behavior | typo, comment, formatting |
| T1 | Contained, tested, trivially reversible | isolated function + test |
| T2 | Standard work (default) | multi-file feature |
| T3 | High blast radius | schema/migration, security-touching, new dependency, **any change to Quorum's own enforcement machinery** |
| T4 | Irreversible / external | data deletion, releases, secrets |

**Code-enforced tier floor**: the Planner proposes a tier; the Gate computes a floor from the diff and takes `max(proposed, floor)`. Tiers raise freely, never lower below floor. Phase 1 floor rules (path-based, in `.quorum/policy.yml`):

- `.github/workflows/**`, `.quorum/policy.yml`, `packages/gate-action/**`, `schemas/**` → floor T3
- `**/package-lock.json`, `**/pnpm-lock.yaml`, dependency manifests with dep changes → floor T3
- migrations / SQL / IaC paths (configurable glob) → floor T3
- everything else → floor T0 (proposed tier governs)

### 1.3 Autonomy tiers A0–A4 (ratified)

A1 is the starting posture. T3/T4 never auto-merge at any autonomy level.

| | T0 | T1 | T2 | T3 | T4 |
|---|---|---|---|---|---|
| **A0** | human | human | human | human | human |
| **A1** (start) | human | human | human | human | human |
| **A2** | auto on green | human | human | human | human |
| **A3** | auto | auto on green + Reviewer ✓ | human | human | human |
| **A4** | auto | auto | auto on green + Reviewer ✓ + Red-team ✓ | human | human |

Promotion is earned (N defect-free instrumented cycles at the candidate grade; N configurable, default 10). Demotion is automatic: any post-merge defect attributed to an auto-merged change demotes one level and posts the reason. Implementation of A2+ is Phase 2; **Phase 1 hard-codes A1** (verify everything, human merges everything) so the matrix above constrains design but requires no promotion machinery yet.

### 1.4 Overnight mechanics (ratified; Phase 2 implementation)

Budgets (tokens / wall-clock / task count) with stop-and-queue semantics; circuit breakers on failed verification, >3 fix loops, mid-flight tier escalation, or enforcement-machinery contact; untrusted-text quarantine (reader agents never hold write access; fork PRs never run with write); morning digest rendered as a pinned issue + check summaries. Phase 1 contribution: the claim ledger and task manifest are designed below to be the digest's data source so nothing is retrofitted.

---

## 2. Repository scaffold (ratified call: monorepo)

One repo (`quorum`), npm workspaces. Rationale: L0/L1/L2 version in lockstep at this stage; splitting repos now creates release ceremony with no consumer benefit. Revisit when L3 vendor bindings ship.

```text
quorum/
├── package.json                 # workspaces root; Node 22 LTS; npm
├── packages/
│   ├── contracts/               # L0 — JSON Schemas + generated TS types (zod source of truth)
│   │   ├── src/claim.ts
│   │   ├── src/ledger.ts
│   │   ├── src/task-manifest.ts
│   │   ├── src/policy.ts
│   │   └── schemas/             # generated JSON Schema output (committed)
│   ├── kernel/                  # L1 — @quorum/kernel: verifier library + CLI (`quorum`)
│   │   ├── src/extract/         # structured-block reader + prose salvage miner
│   │   ├── src/verify/          # per-claim-type checkers
│   │   ├── src/ledger/          # ledger build + markdown render
│   │   ├── src/forge/           # ForgeAdapter interface + GitHub impl + local-git impl
│   │   └── src/cli.ts           # quorum verify | quorum tier | quorum validate
│   └── gate-action/             # L2 — composite/JS Action wrapping the kernel
├── examples/demo/               # toy project exercised in CI as the living worked example
├── docs/                        # existing: PRINCIPLES, GLOSSARY, adr/, + this spec
├── .quorum/                     # policy.yml, ledgers/, manifests/ (this repo dogfoods itself)
└── .github/workflows/
    ├── ci.yml                   # build, test, schema validation
    └── quorum-verify.yml        # the Gate, running on this repo's own PRs
```

---

## 3. L0 contracts — Phase 1 schemas

Zod definitions are the source of truth; JSON Schema is generated and committed; CI fails if generated output drifts. Lite tier only in Phase 1; full-tier supersets are Phase 2 and must be strict supersets (additive fields only).

### 3.1 Claim (`quorum.claim/v1`)

```jsonc
{
  "schema": "quorum.claim/v1",
  "id": "clm_01J...",                  // ULID, generated
  "task": "QRM-12",                    // task manifest id
  "agent": "builder",                  // role id from manifest
  "type": "file_created",              // enum below
  "subject": { "path": "src/foo.ts" }, // shape depends on type
  "expected": { "sha256": "ab12..." }, // optional; enables content verification
  "stated_at": "2026-06-12T03:14:00Z"
}
```

`type` enum and verification semantics (Phase 1 set):

| type | subject | verified when |
|---|---|---|
| `file_created` | `{path}` | file exists at PR head; if `expected.sha256` present, hash matches |
| `file_modified` | `{path}` | file exists, differs from merge-base; hash check if present |
| `file_deleted` | `{path}` | absent at head, present at merge-base |
| `commit_pushed` | `{sha}` | SHA resolvable and reachable from PR head |
| `pr_opened` | `{number}` | PR exists, head matches claimed branch |
| `issue_filed` | `{number}` | issue exists, author is the claiming App identity |
| `review_posted` | `{pr, surface?}` | found via **three-endpoint poll** (reviews, issue comments, line comments) with timestamp+id lexicographic tie-break |
| `test_passed` | `{check_name}` | named check run concluded `success` at head SHA |

Statuses a claim can land in: `verified` | `failed` | `unverifiable_disclosed` (agent declared it could not verify — honest, fail-open at T0/T1, fail-closed at T2+).

### 3.2 Claim transport (git-native)

Claims travel as a committed file on the PR branch: `.quorum/claims/<task-id>.jsonl` (one claim per line, append-only — append-only-per-task sidesteps the concurrent-writer merge-conflict problem flagged at kickoff; concurrent agents write distinct task files). The Gate also accepts a fenced ` ```quorum-claims ` JSON block in the PR body as a secondary source. **Strict mode**: claims file required, parse failure = check failure. **Salvage mode**: no file required; the miner scans PR body + commit messages for action-claim patterns; results advisory only.

### 3.3 Task manifest (`quorum.task/v1`) — lite tier

```jsonc
{
  "schema": "quorum.task/v1",
  "id": "QRM-12",
  "title": "Add ledger markdown renderer",
  "tier_proposed": "T1",
  "tier_effective": null,              // written by the Gate: max(proposed, floor)
  "acceptance": ["renders 3 fixture ledgers byte-identically"],
  "branch": "qrm-12-ledger-render",
  "state": "in_progress",              // planned|in_progress|handed_back|verified|merged|blocked
  "agents": { "builder": "claude-opus-4-8", "reviewer": "gpt-codex" }
}
```

Lives at `.quorum/manifests/<id>.json` on the task branch. The Phase 1 state machine is deliberately minimal: `planned → in_progress → handed_back → verified → merged|blocked`. Review/red-team states arrive in Phase 2 with the agents.

### 3.4 Ledger (`quorum.ledger/v1`)

The Gate's output of record, written to the check summary and committed to `.quorum/ledgers/<task-id>.json` on merge. Fields: task, head SHA, mode (strict|salvage), per-claim results (claim id, status, evidence — e.g. resolved hash, API record id), counts, tier_effective, verdict. Markdown render (the demo asset): `Quorum: 14 claims — 12 verified · 1 disclosed-unverifiable · 1 FAILED → blocking (T2, strict)`.

---

## 4. L1 kernel — `@quorum/kernel`

Pure deterministic TS. No LLM calls, ever (principle: the gate inherits no drift). Public surface:

- `extractClaims(sources, mode)` → claims[] — structured reader (file + PR-body block) and salvage miner (regex/pattern table derived from the AMAS incident corpus; patterns are data, in `extract/patterns.json`)
- `verifyClaim(claim, forge)` → result — dispatch table per `type` above
- `buildLedger(results, ctx)` / `renderLedger(ledger)` → markdown
- `computeTierFloor(diffPaths, policy)` → tier
- `validateArtifact(json, schemaId)` → ok | errors
- `ForgeAdapter` interface: `getFile(ref,path)`, `resolveCommit(sha)`, `getPR(n)`, `getIssue(n)`, `getReviewsAllEndpoints(pr)`, `getCheckRuns(sha)`, `compare(base,head)`. Two Phase 1 implementations: `GitHubForge` (REST via App-identity token) and `LocalGitForge` (plain git, for CLI/offline use — this is the off-ramp guarantee made literal: the verifier works with no forge at all for file/commit claims).

CLI: `quorum verify --task QRM-12 [--mode strict|salvage] [--local]`, `quorum tier --diff <range>`, `quorum validate <file>`. Exit codes: 0 pass, 1 claim failure, 2 protocol/parse failure.

**Test fixtures are the AMAS incident corpus, transcribed**: Sub-shape A (fabricated SHA / nonexistent file), Sub-shape B (correct content, phantom citation — verifier must mark the citation failed while a content-hash match on the finding is recorded as evidence, preserving the "the finding is still real" distinction), three-endpoint emission asymmetry including the same-second tie-break case, and the five-point post-handback check expressed as a fixture suite. Phase 1 acceptance requires all fixtures green.

## 5. L2 gate — `quorum-verify` Action

Trigger: `pull_request` (and `workflow_dispatch`). Steps: mint scoped App-identity token → read `.quorum/policy.yml` → compute `tier_effective` and write it back to the manifest check output → extract claims (mode per policy/tier) → verify each → post ledger as check summary → set conclusion.

Fail-closed / fail-open taxonomy (per policy, defaults):

- Any `failed` claim → **fail** (all tiers, both modes-strict; salvage mode reports but passes)
- `unverifiable_disclosed` → pass at T0/T1, fail at T2+
- Kernel/parse error → **fail closed** at T2+, warn at T0/T1
- Missing claims file in strict mode → fail

Branch protection on the demo repo (and on `quorum` itself) lists `quorum-verify` as a required check. That single GitHub setting is what converts the kernel from advice into enforcement — nothing else in Phase 1 claims the word.

Security posture (Phase 1 slice of principle 12): the Action requests read-only contents + checks:write only; runs on fork PRs with no secrets (salvage mode, advisory); the App private key lives in repo/org secrets and never reaches agent contexts.

## 6. Phase 1 milestones & acceptance

1. **M1 — contracts**: zod schemas + generated JSON Schema + drift check in CI.
2. **M2 — kernel**: extract/verify/ledger green against the full AMAS fixture suite; `LocalGitForge` working.
3. **M3 — gate**: Action runs on this repo's own PRs (dogfood from first PR); strict mode demonstrably blocks a seeded bad claim.
4. **M4 — demo**: `examples/demo` exercised in CI — a scripted task (manifest → branch → claims → PR → ledger → human merge) that doubles as the worked example and the README screenshot source.
5. **M5 — adoption floor**: README quickstart ≤2 pages ("install the Action, get a ledger"), glossary entries for every new term in this spec, honest cost note.

Acceptance for Phase 1 overall: a stranger can add the Action to a repo and see a claim ledger on their next PR within one hour, with zero external services, and a seeded fabricated claim visibly blocks a strict-mode merge.

## 7. Builder direction (copy-paste artifact)

```text
ROLE: Builder (Implementer) for Quorum, task QRM-1 "Phase 1 vertical slice — M1+M2".
READ FIRST: docs/SPEC-PHASE-1.md §2–§4, docs/PRINCIPLES.md, docs/GLOSSARY.md.
SCOPE: packages/contracts and packages/kernel exactly as specified in §3–§4.
  Monorepo per §2. Node 22, npm workspaces, TypeScript strict. No other deps
  beyond zod, zod-to-json-schema, vitest, and @octokit/rest (kernel/forge only).
OUT OF SCOPE: the Action (M3), demo (M4), any LLM integration, any Phase 2 schema.
HARD RULES:
  - The kernel makes zero LLM calls and has zero network deps outside ForgeAdapter.
  - Every artifact you produce gets a claims file: append each material claim
    (file_created, test_passed, commit_pushed) to .quorum/claims/QRM-1.jsonl
    per schema quorum.claim/v1 — Quorum dogfoods from its first PR.
  - AMAS fixture suite (§4) must pass; do not weaken a fixture to pass it.
  - If the spec is ambiguous, stop and hand back with the question; do not assume.
ACCEPTANCE: CI green on schema-drift check + full kernel test suite;
  `quorum verify --local --task QRM-1` runs clean on your own claims file.
HANDOFF: update .quorum/manifests/QRM-1.json state to handed_back; open PR to main;
  PR body contains a quorum-claims block mirroring the claims file.
```

Reviewer direction (cross-family, e.g. GPT/Codex) ships with M2's hand-back; drafting it against a real diff beats drafting it speculatively.

## 8. Agent assignments and remaining owner inputs

**Ratified (2026-06-12):**

1. **Builder = `claude-opus-4-8`** via Claude Code. Claude Fable 5 was the originally-anticipated heavy-reasoning model but was withdrawn by Anthropic on 2026-06-12; Opus 4.8 is the strongest generally-available agentic-coding model and is the Builder of record for Phase 1.
2. **Reviewer = `gpt-codex`** (OpenAI family) — confirmed. Builder (Anthropic) ≠ Reviewer (OpenAI) satisfies principle 7 (cross-family review).
3. **Repo home = `bryce-murphy/quorum`**, public — confirmed and live, with `protect-main` ruleset active (PR required, force-push and deletion blocked, approvals 0 until the Reviewer Action ships).

**Still open:**

4. **App registration**: creating the GitHub App identity (name suggestion: `quorum-gate`) requires the owner's account — needed before M3, not before M1/M2. Say when.
5. **N for autonomy promotion** (default 10 defect-free cycles) — fine to defer to Phase 2 ratification.
