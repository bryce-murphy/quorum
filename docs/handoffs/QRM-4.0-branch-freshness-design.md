# QRM-4.0-branch-freshness — design (prerequisite [2])

**Task:** QRM-4.0 prerequisite **[2]**, verbatim from `.quorum/manifests/QRM-4.0.json`:

> "PREREQUISITE - mechanical branch-freshness: 'require branches up to date before merge' is enforced or consumed as an unspoofable forge signal, closing the stale-tightening residual from QRM-3.2's merge-base grading decision"

**Tier proposed:** **T3** (trust boundary). The Gate consumes freshness as a precondition of policy provenance; a skipped, spoofed, or false-fresh check re-opens the old-permissive-policy downgrade vector. Mandatory cross-family (Codex) red-team per PMN-001.
**Design base:** `main` @ `95df5e9`. **Cross-architect review:** GPT — PROCEED-TO-PROTOTYPE with five amendments, all accepted (§6).
**Status of every claim below:** probe-confirmed against the real forge unless explicitly labeled otherwise (§4).

---

## 1. The residual this closes

QRM-3.2 (Q4) chose to grade against the policy at the **merge base**, not the base-branch tip — for three reasons that remain correct and are **not** revisited here: the fork point is **stable** (it cannot move under the PR), **trusted** (it is on `main`'s history), and **diff-consistent** (it is the same base as the graded range `mergeBase..HEAD`). That decision named its own residual and its own closure mechanism at the time:

> "grade by merge-base (fork point), not base-branch tip … the stale-tightening residual is closed at the Gate via require-up-to-date-branches (tracked in QRM-4.0)." — `docs/handoffs/QRM-3.2-review.md`

QRM-4.0 [1] then shipped the forge-mode policy read and re-recorded the same residual as **[2]'s job**:

> "the stale-fork / old-permissive-policy case (a PR forked from an old commit whose merge-base carries a laxer policy). `[1]` reads the fork point and preserves merge-base grading by design; dragging the fork forward is prerequisite **[2]**'s (branch-freshness) job." — `docs/handoffs/QRM-4.0-policy-read-review.md`

**The vector.** A PR forked from an old commit arrives with an old fork point. The old fork point carries the policy *of its era* — laxer floors, wider `exempt_paths`. [1]'s merge-base read faithfully loads that old policy. Nothing drags the fork forward. A stale fork is therefore a **policy-downgrade channel that requires no malice and no spoofing** — it is the default behavior of any long-lived branch.

**The closure principle.** When

```
merge_base(protectedBranch, prHeadSha) === tip(protectedBranch)
```

the fork-point policy and the current protected-branch policy are **the same commit** — hence the same bytes — *by construction*. The residual does not need to be detected, bounded, or mitigated; under this equality it cannot exist. Q4's three properties survive untouched: we do not re-point grading at the tip, we make staleness itself the blockable condition.

---

## 2. Scope — claimed and explicitly not claimed

**Claims [2] only.** This task ships a deterministic, fail-closed freshness capability and binds the Gate-facing policy path to it. It does **not** wire the Gate ([0]), does not add a required status check, does not route the CLI to forge mode, and does not touch `[3]` (trusted/pinned verifier). Capability, not enforcement (**principle 2: do not claim enforcement not shipped**).

**The manifest's disjunction ("enforced *or* consumed as") resolves as:**

- **[2] ships the "consumed-as-unspoofable-signal" half** — verifier-side, deterministic, from certified commit-graph object identity.
- **The "enforced" half** — GitHub's *require branches to be up to date before merge* (strict required checks), which re-dirties a required check when the base advances and thereby closes the **grade-to-merge race** — is deferred to **[0]** as a **hard, fail-closed wiring contract** (§7). It is repo *configuration*, not committed bytes; attesting it from [2] would pull App-level permissions ([3] / App provisioning) into a task the manifest calls *mechanical*.

**[2] does not close the grade-to-merge race and does not claim to.** [2] proves freshness *at verification time*. Between verification and merge, `protectedBranch` may advance. Only strict required-check semantics (or merge-queue freshness, or an equivalent unspoofable forge mechanism) closes that window — and that is [0]. Recorded here so the Gate does not imply protection it lacks (CHARTER §6: if a doc describes protection the repo lacks, the repo wins).

---

## 3. Design

### 3.1 New: `resolveRefCommit(ref)` on `GitHubForge`

Resolves a ref to its tip **commit SHA**, **certified full-lowercase-40-hex by construction** — the same discipline `resolveMergeBase` already applies to `merge_base_commit.sha`.

```
resolveRefCommit(ref: string): Promise<ForgeResponse<string>>
  GET /repos/{owner}/{repo}/commits/{ref}  ->  data.sha
  certify /^[0-9a-f]{40}$/  ->  TreeParseError on malformed
  404 -> absent()   (absent => FAILED, per adapter.ts:7 — absence is never freshness)
```

**Why not reuse `resolveTreeSha`?** It exists (`forge/github.ts:333`) and reads the same endpoint, but (a) it is `private`, and (b) **its `commitSha` guard is `typeof === "string"` only — shape-checked, not 40-hex certified.** Using it would put an *uncertified* SHA on one side of an equality check whose other side (`resolveMergeBase`) is certified by construction. **Asymmetric certification across an equality check is exactly where an under-floor hides.** Strengthening `resolveTreeSha` in place would instead change a shipped contract with existing callers (`compare`, `listFiles`) — trust-boundary churn for no gain. A separate certified resolver keeps both sides symmetric and touches no shipped contract.

### 3.2 New: `assertBranchFreshness(forge, protectedBranch, prHeadSha)`

```
assertBranchFreshness(forge, protectedBranch, prHeadSha)
  -> { mergeBaseSha, protectedTipSha }        // both certified 40-hex
  -> throws to block; NEVER returns a default
```

Sequence — **the order is load-bearing, not incidental**:

1. **Certify `prHeadSha` as full-lowercase-40-hex — the FIRST statement, before any network call.** ([1] Fix-A pattern; Codex BLOCKed [1] for exactly this omission. Sentinel zero-network-call tests are mandatory, not optional.)
2. `resolveMergeBase(protectedBranch, prHeadSha)` → certified `mergeBaseSha`. `absent` → **block** (correct-by-layer).
3. `resolveRefCommit(protectedBranch)` → certified `protectedTipSha`. `absent` → **block** (correct-by-layer).
4. `mergeBaseSha !== protectedTipSha` → throw **`BranchFreshnessError`**, carrying both SHAs.

**The call-order invariant.** Merge base is read **first**, protected tip **second**. If `protectedBranch` advances between the two reads, the tip read returns a commit *newer* than the compare-time merge base, equality fails, and the check **over-blocks**. The reverse order admits a **false-fresh** window. Over-blocking is the safe direction under CHARTER §4 (a silently-wrong verified claim is worse than an over-cautious block). **Confirmed live — C4, §4.** This invariant gets a comment in the bytes and a dedicated regression test.

**No per-read retry inside the sequence (GPT amendment 6).** The observed order must not be reversed *or blurred*. Working the retry directions through:

- Retrying the **merge-base** read is benign — it still completes before the tip read, and `merge_base(protected, head)` does not move when `protected` merely advances; the fork point is fixed by history.
- Retrying the **tip** read is benign — a later re-read returns a tip that is *newer or equal*, making equality *less* likely to hold → over-block. Safe direction.
- What is **not** benign is a **stale tip read**: if the forge serves the tip from an eventually-consistent replica and returns an *older* tip that happens to equal the merge base, the result is a **false-fresh** — the one outcome this design must never produce. Not closable by [2]; routed to [0] (§7).

**Rule:** on any transient failure, **fail closed, or re-run `assertBranchFreshness` whole from the top (both reads, in order). Never retry one read in isolation inside the sequence.**

**Byte-level pin.** `forge/github.ts:67` constructs `new Octokit({ auth: opts.token })` — plain `@octokit/rest@^21`, **no retry plugin, no throttling plugin, no request hooks**. No hidden auto-retry re-issues a read inside our sequence today. This invariant is therefore *forward-looking*: it protects a property that currently holds **by default**, and would be silently lost if someone later added `@octokit/plugin-retry` for unrelated flaky-network reasons. **A comment at the call site must record this**, so the protection does not evaporate in a future unrelated change.

### 3.3 `forgePolicySource` becomes freshness-bound

**GPT amendment 2, accepted — this reverses the Architect's initial lean.** The original design shipped `assertBranchFreshness` as a standalone capability plus a *recorded contract* that [0] must call it. That is **prose where a check could be** — precisely the debt CHARTER names.

Weigh the two failure modes:

- **Forgotten composition at [0]:** a future caller obtains a policy via the already-shipped `forgePolicySource` without the freshness attestation → **silent under-floor**, and it recreates the exact residual [2] exists to close.
- **Over-coupled seam:** less diagnostic flexibility; stale branches over-block.

The first is an under-floor; the second is an over-block. The calibration decides it. **`forgePolicySource` calls `assertBranchFreshness` internally and uses the returned `mergeBaseSha` as its policy ref.** It becomes structurally impossible to obtain a Gate-facing policy without a freshness attestation. `assertBranchFreshness` remains exported as a primitive for reuse and testing.

This is safe to do **now, and only now**: [1] shipped `forgePolicySource` as capability with **zero forge-mode callers routed to it** — there is no caller to break. Deferring this coupling until a caller exists would make it a breaking change instead of a free one.

> **Supersession note.** `docs/handoffs/QRM-4.0-policy-read-review.md` describes `forgePolicySource` as it shipped in #21 — accurate when written. This task changes its contract. The [1] record is **not** edited; the supersession is recorded in [2]'s review record and in git history.

### 3.4 `protectedBranch` provenance

An **invocation parameter**, exactly as `forgePolicySource` already takes `protectedBaseBranch`. **Never derived from PR event data** (the inherited [0] base-mismatch contract). Note the circularity this avoids: freshness is what *makes* the fork-point policy current, so it cannot itself depend on fork-point policy — or on PR-controlled event fields — for the branch name it checks against.

### 3.5 Failure contract

`assertBranchFreshness` **throws to block and never returns a default.** Three distinct classes, deliberately not collapsed:

| condition | throws | layer |
|---|---|---|
| stale fork (`mergeBase !== tip`) | `BranchFreshnessError` | freshness |
| malformed `prHeadSha` | certification error, **zero network calls** | input |
| malformed returned SHA (either side) | `TreeParseError` | forge |
| unresolvable branch / head (`absent`) | correct-by-layer error, **not** `BranchFreshnessError` | forge |

**Consequence for [0], inherited from [1] and reaffirmed:** the Gate must be built **catch-all — any throw blocks.** No caller may assume `BranchFreshnessError`-only, exactly as no caller may assume `PolicyReadError`-only. Confirmed by C7 (§4): the real unresolvable-branch path blocks as a *forge-layer* error, not a freshness error.

---

## 4. Probe results — confirmed, not predicted

Prototyped against the **real built kernel** (`GitHubForge` from `dist`) and the **real GitHub API** with real auth, over throwaway `probe/*` refs on the live repo built via `commit-tree` plumbing (no checkout, working tree never touched, `git status --short` empty throughout — the QRM-3.2 harness rule). Probe script: throwaway, outside the working tree, **not a repo deliverable** (§8 of the operating discipline). Build was refreshed first (`npm run build`) — a stale `dist` caused a phantom BLOCK in QRM-3.2.

**15/15 pass.**

| case | topology | confirmed result |
|---|---|---|
| **P1** | tip-resolution pin | `repos.getCommit(ref)` and `git.getRef(heads/<ref>)` **independently** resolve the tip to the **same certified 40-hex SHA** (`objectType=commit`). Two routes, one answer — `getCommit` is a sound tip resolver; the `getRef` route is not needed in shipped code. |
| **C1** | stale fork | **Blocks.** `mb=cd951d9… ≠ tip=95df5e9…` → `BranchFreshnessError`. **The QRM-3.2 Q4 residual, closed.** |
| **C2** | protected **merged into** an old fork (no rebase) | **Passes.** Old ancestry, but merge base resolves to the protected tip. **"Up to date" ≠ "rebased"** — verified against the real compare API, not assumed. This was the case most likely to embarrass the design. |
| **C2b** | fresh fork, 1 commit ahead | **Passes.** |
| **C3** | `head === tip` | **Passes** — freshness is true; empty-delta is a downstream concern, not a freshness failure. |
| **C4** | **drift between the two reads** (interactive: protected advanced mid-check) | **Over-blocks.** `mb=95df5e9…` vs `tip=ddd10cf…` → `BranchFreshnessError`. **The call-order invariant is proven from behavior, not reasoned into.** |
| **C5** | 6 malformed `prHeadSha` (39-hex, uppercase-40, empty, `null`, junk) | All throw with **ZERO network calls** (sentinel counters). |
| **C6** | tampered returned SHA, **both sides** | Certification throws on a bad merge base *and* on a bad tip; garbage is never compared. |
| **C7** | unresolvable protected branch | Fails closed via `resolveMergeBase` → `absent` → **correct-by-layer error, not `BranchFreshnessError`.** Confirms the [0] catch-all requirement. |

**C8** (`protectedBranch` never sourced from PR event data) is a property of the **call site**, not a runtime behavior. Not probeable; **verified at re-gate by reading committed bytes.**

### 4.1 First-party behavior boundaries recorded (neither is a gap)

- **`repos.getCommit` on a *nonexistent* ref returns 422, not 404** ("No commit found for SHA: …"). The shipped `isNotFound` guard is 404-only, so a 422 propagates as a raw forge-library `HttpError` rather than mapping to `absent`. **Fails closed either way**, and in the real sequence the merge-base read 404s *first* (C7), so the 422 path is **unreachable**. Recorded, not widened: widening a shipped guard for an unreachable case that already fails closed is churn. Flagged for Codex as a deliberate decision, not an oversight.
- **`resolveTreeSha`'s `commitSha` is shape-checked, not 40-hex certified** (`forge/github.ts:333`). Untouched by this task; it is the reason §3.1 adds a separate certified resolver instead of reusing it.

---

## 5. Considered and rejected: single-response equality

GitHub's compare response carries `merge_base_commit`, **`base_commit`**, `status`, `ahead_by`, and **`behind_by`** in **one** payload. `base_commit.sha` is the tip of the `base` ref at request time. So in principle a **single** compare call could yield both sides of the equality — **no second read, no drift window at all**, making the call-order invariant moot rather than load-bearing. That is a real advantage and it is not dismissed lightly.

**Rejected, on the bytes.** Our shipped parse **discards both fields**:

- `compareStatus` (`forge/github.ts:378`) reads **only `res.data.status`**, and `CompareStatus` (`forge/adapter.ts:56`) is a bare string union — `"ahead" | "behind" | "identical" | "diverged"`. No SHA field, no numeric field.
- `resolveMergeBase` (`forge/github.ts:126`) reads **only `merge_base_commit.sha`**.

Reaching single-response equality therefore means **widening the parsed response contract of a shipped, Codex-reviewed, trust-boundary function** to carry a new SHA — to save one network read. Against that: two reads reuse **already-shipped, already-red-teamed** certification, add **no field to any existing type**, and **touch no [1] contract**; the drift window they open is closed in the **safe direction** by the call-order invariant (**C4-confirmed**). Contract stability beats atomicity here.

**`behind_by` is not the blocker, under any variant.** Per GPT Q1: it is a *derived integer*, not committed object identity. Certified SHA equality is the direct proof that the fork-point tree and the current protected tree are the **same commit object**. If a future task does surface `behind_by`, it is **corroboration only** — and a `behind_by` that *contradicts* SHA equality is **malformed first-party data and must block**.

Recorded at length so this is not re-litigated: the atomicity argument **lost to contract stability**, it was not missed.

---

## 6. Cross-architect review (GPT) — amendments, all accepted

1. **Block on certified SHA equality, not `behind_by`.** → §3.2, §5.
2. **Do not leave [2] as prose-only composition at [0]; make the Gate-facing policy path freshness-bound.** → §3.3. *Reversed the Architect's initial lean.*
3. **Shape-certify all three SHAs** (`prHeadSha`, `mergeBaseSha`, `protectedTipSha`); sentinel zero-call tests for malformed head. → §3.1, §3.2, §3.5; C5/C6-confirmed.
4. **Keep the grade-to-merge race at [0], but make the [0] wording fail-closed and non-optional.** → §2, §7.
5. **Adversarial prototype cases beyond the happy/stale pair.** → §4 (all eight, plus C2b).
6. **The call order must remain a regression-tested invariant; neither read may be independently retried in a way that could reverse or blur the observed sequence.** → §3.2. *(Post-prototype delta review, where GPT also confirmed the single-response rejection in §5: atomicity "would not close an under-floor path left open by the two-read design.")*

GPT's Q4 adversarial pass found **no under-floor pass** in the equality check given these amendments. The **protected-branch-rewind** case (force-push moves the tip *back* to the old merge base → equality can pass) is dispositioned as **correct**: under a rewind, fork-point policy *is* current protected policy by definition. Preventing unsafe force-pushes is branch protection — **[0]/[3]**, not [2].

---

## 7. Contracts handed to [0] (recorded, not implemented here)

- **Catch-all.** Any throw blocks. `forgePolicySource` (now freshness-bound) may throw `BranchFreshnessError`, `PolicyReadError`, **or** a propagated forge-layer error (`TreeParseError`, `HttpError`). No caller may assume a single error class. *(Inherited from [1]; C7 reaffirms it.)*
- **Base-mismatch.** The Gate MUST assert `pull_request.base.ref === protectedBranch` and block on mismatch. The PR base is **never** the policy source. *(Inherited from [1].)*
- **Strict-freshness wiring — NEW, hard requirement.** The Gate MUST NOT claim L2 enforcement unless *require branches up to date before merge* (strict required checks), merge-queue freshness, or an equivalent **unspoofable forge mechanism** is active. [2] proves freshness at verification time; **only this closes the grade-to-merge race.** Without it, the Gate is incomplete — not merely less convenient.
- **Forge read-consistency — NEW, recorded residual.** [2]'s freshness proof is only as good as the forge's tip read. A tip served from an eventually-consistent replica could return an *older* tip that equals the merge base → **false-fresh**. [2] cannot close this: it is a property of the forge's read path, not of our code, and no amount of client-side certification detects a *well-formed but stale* SHA. It is closed at [0] by the strict required check, where the **forge itself** enforces up-to-date at merge time rather than trusting our read. This is the second reason the [0] strict-freshness contract above is a hard requirement rather than a convenience: it backstops both the grade-to-merge race **and** our own read.

---

## 8. Builder scope

**New:** `resolveRefCommit` on `GitHubForge` (+ `ForgeAdapter` interface); `assertBranchFreshness`; `BranchFreshnessError`.
**Changed:** `forgePolicySource` — freshness-bound (§3.3).
**Unchanged (do not touch):** `resolveMergeBase`, `resolveTreeSha`, `compareStatus`, `CompareStatus`, `compare`, `listFiles`. **No shipped parse contract is widened.**

**Tests — regression pins, not incidental passes** (the [1] "tests weaker than they look" CONCERN): every §4 case; sentinel **call-counter** tests asserting **zero** network calls on malformed `prHeadSha`; **both-sided** SHA-tamper tests; a dedicated test for the **call-order invariant** — assert the merge-base read is issued **before** the tip read (call-sequence recorder, not just a count) and that a mid-sequence advance **over-blocks**; an `absent`-blocks test on **each** read; a test that `forgePolicySource` **cannot** yield a policy on a stale fork.

**No per-read retry (§3.2).** Do **not** add `@octokit/plugin-retry`, `plugin-throttling`, or any request hook. On transient failure, fail closed or re-run `assertBranchFreshness` **whole**. Record the reason in a comment at the Octokit construction site (`forge/github.ts:67`) so a future unrelated change does not silently blur the sequence.

`certifyCommitSha` in `policy-source.ts` (~line 99) is a **regression backstop** from [1] — redundant but live. **Keep it.**

**Routing (advisory):** T3, novel/adversarial → **Opus 4.8, xhigh**. Builder reports actual model + effort at hand-back (not attestable from bytes).

---

## 9. Deliverables

- This design doc.
- Per-task manifest `.quorum/manifests/QRM-4.0-branch-freshness.json` — `state: planned` → `merged` at bookkeeping (the #20 precedent).
- Implementation + tests.
- Review record `docs/handoffs/QRM-4.0-branch-freshness-review.md` — including the §3.3 supersession note.

**`QRM-4.0.json` is NOT edited.** It is a **frozen requirements spec**; satisfied prerequisites are recorded externally (review record, per-task manifest, git history) — never by toggling item status. The sole precedent for touching it is a *ratified content amendment* to a prerequisite string (PR #20, item [3]). [2] produces none.

**Probe script and all prompts are paste-only artifacts. Not committed.**
