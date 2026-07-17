# QRM-4.0-branch-freshness — task review record

**Task:** Mechanical branch-freshness (QRM-4.0 prerequisite **[2]**) — consume "require branches up to date before merge" as an unspoofable forge signal (certified `merge_base(protectedBranch, prHeadSha) === tip(protectedBranch)`), closing QRM-3.2's stale-tightening residual, and make `forgePolicySource` freshness-bound.
**Merge base:** `95df5e9` (main). **Branch:** `qrm-4.0-branch-freshness` (deleted post-merge). **Merged:** [#24](https://github.com/bryce-murphy/quorum/pull/24), squash `a9952bd`, 2026-07-17, merged by Bryce Murphy (Owner). **Loop completed before merge:** Architect re-gate from a fresh clone, then Codex focused re-review of the fix delta returned CLEAR (confirmed 8bb19e0^ === 86c5dbb, both NIT fixes closed, BLOCK completion-claim correction not overclaimed). Per-task manifest deliberately kept planned: the enforcement half ([0] strict required-check) is unshipped, so [2] is NOT satisfied (see section 2).
**Tier:** T3 (trust boundary — freshness is a precondition of policy provenance; a false-fresh pass re-opens the old-permissive-policy downgrade vector). **Cross-architect design review:** GPT (PROCEED-TO-PROTOTYPE, five amendments, all accepted — design §6). **Cross-family red-team:** Codex.
**Builder (kernel [2]):** Opus 4.8. **Fix-delta builder (this record):** Opus 4.8, effort **high** (advisory routing was xhigh; reported here because effort is not attestable from committed bytes).

This record is the committed history of the task so its arc — including the Codex correction below — is git-durable, not chat-only (principle: verify, don't trust; git is source of truth).

---

## 1. Scope — the disjunction resolves as *kernel half only*

The manifest item [2] is a disjunction: freshness is *"enforced **or** consumed as an unspoofable forge signal."* This task ships **exactly one half of it**, and this record exists partly to keep that boundary honest.

**Shipped — the KERNEL / "consumed-as-signal" half.** A deterministic, fail-closed, **verification-time** freshness check derived from certified commit-graph object identity:

- `GitHubForge.resolveRefCommit(ref)` — resolves a ref to its tip commit SHA, certified full-lowercase-40-hex by construction (symmetric with `resolveMergeBase`), 404 → `absent`. Added to the `ForgeAdapter` interface; `LocalGitForge` resolves via `git rev-parse ^{commit}`, `MemoryForge` via a `refs` fixture map.
- `assertBranchFreshness(forge, protectedBranch, prHeadSha)` — proves `merge_base === tip` from certified SHAs, throws to block on every other outcome, never returns a default. Load-bearing order: certify head first (zero network), read merge base first, protected tip second; a mid-check tip advance **over-blocks** (the safe direction).
- `forgePolicySource` is now **freshness-bound** (design §3.3): it calls `assertBranchFreshness` internally and grades against the returned fork point, so **it is structurally impossible to obtain a Gate-facing policy on a stale fork.** Pinned by a test where the fork point carries a readable policy but the tip has advanced: `forgePolicySource` throws `BranchFreshnessError` and `getContent` is called **0** times — the stale policy is never read.

**NOT shipped — the ENFORCEMENT half. [2] is therefore NOT SATISFIED yet.** See §2. The per-task manifest stays `state: planned`; `QRM-4.0.json` is untouched.

Also explicitly not claimed (principle 2 — do not claim enforcement not shipped): the Gate wiring ([0]), a required status check, routing the CLI to forge mode (stays `--local`), and the trusted/pinned verifier ([3]).

---

## 2. Completion-claim correction (the Codex BLOCK) — [2] is not satisfied until the enforcement half lands

Codex's cross-family red-team returned **BLOCK + 2 NITs**. The **BLOCK is a completion-claim correction, not a code defect**: the kernel is correct and fail-closed, but freshness proven *at verification time* is not the same as freshness *enforced at merge time*. Claiming [2] complete on the kernel alone would imply protection the repository does not have — precisely the failure CHARTER §6 names (*"if a doc describes protection the repo lacks, the repo wins"*).

**The unspoofable enforcement half is `strict_required_status_checks_policy: true` on the `protect-main` ruleset** — GitHub's *require branches to be up to date before merge*. It re-dirties a required check when the base advances, and thereby closes both the grade-to-merge race and the forge read-consistency residual (design §7). It is **repo configuration, not committed bytes**, and it is **mechanically impossible to set today**, because *strictness is a parameter of a `required_status_checks` rule, and no such rule exists.*

**Evidence, verified from the live forge 2026-07-15 (not transcribed):**

- **`protect-main` ruleset** (`id 17637003`, `enforcement: active`, target `~DEFAULT_BRANCH`) has exactly three rules: **`deletion`**, **`non_fast_forward`**, and **`pull_request`** (`required_approving_review_count: 0`, no required reviewers, no code-owner review, no thread-resolution). **There is NO `required_status_checks` rule.** `strict_required_status_checks_policy` has no rule to attach to — setting it is impossible until [0] registers `quorum-verify` as a required check.
- **PR #24** (draft, base `main`) is **mergeable with no required-check gate**. At the time of the fix-delta re-verification it reports `mergeStateStatus: CLEAN`, its sole check `build-test` (workflow `ci`) having completed **SUCCESS** as an **advisory** (non-required) check. *(The task sheet recorded `UNSTABLE` from an earlier observation, when `build-test` was still pending; that datum is now stale. Both readings confirm the same fact: a **pending REQUIRED** check would force `mergeStateStatus: BLOCKED`, and neither `UNSTABLE` nor `CLEAN` is `BLOCKED` — so no required status check gates `main` today.)*

**Disposition:** the kernel half ships; the manifest stays `planned`; the enforcement half is handed to [0] as a hard, fail-closed wiring contract (§4). [2] is satisfied only when both halves are present.

---

## 3. The two NITs — fixed in code (fix delta on this branch)

Both were fixed without adding or altering any freshness **logic** — the changes are to error *type* and diagnostic *construction* only.

### NIT 1 — the certification pin was defeatable (a test weaker than it looked)

`assertBranchFreshness`'s malformed-`prHeadSha` guard threw a bare `TypeError` and built its message with `JSON.stringify(prHeadSha)`. Codex's repro: `prHeadSha = 1n` makes **`JSON.stringify` throw its OWN native `TypeError`** ("Do not know how to serialize a BigInt") **before** our error is constructed. The old pin asserted `toBeInstanceOf(TypeError)` — so it **passed on an unrelated native throw, with zero network calls**, satisfying the assertion for the wrong reason. This is exactly the "[1] tests-weaker-than-they-look" class.

**Fix (`packages/kernel/src/branch-freshness.ts`):**
- Introduced a **bespoke error class, `HeadShaCertificationError`**, for the malformed-head **INPUT** layer — deliberately **distinct** from `BranchFreshnessError` (freshness) and from forge-layer `TreeParseError` (§3.5's three-class contract, not collapsed). A dedicated class cannot be impersonated by a native throw the diagnostic accidentally raises.
- The diagnostic is built so **message construction can never throw**: `JSON.stringify` runs **only on a confirmed string**; for a non-string it interpolates the `typeof` (`<non-string: bigint>`), never `JSON.stringify`/`${}` on the raw input. (The `||` guard already short-circuits so `FULL_COMMIT_SHA.test` — itself a throw on a Symbol — is only reached for a string.)
- **Same safe-diagnostic fix applied to `certifyCommitSha` in `policy-source.ts`** (the [1] backstop surface, which certifies `prHeadSha` before any network call and had the identical `JSON.stringify` exposure). It keeps throwing its own `PolicyReadError` — the backstop layer stays distinct from the input class.

**Tests — pinned to the bespoke class, and proven to bite:**
- The C5 malformed-head block now asserts `toBeInstanceOf(HeadShaCertificationError)` **and** `not.toBeInstanceOf(TypeError)` **and** zero network calls, with new `1n` **and** `Symbol()` cases.
- A parallel pin in `policy-source.test.ts` asserts `certifyCommitSha`'s backstop raises `PolicyReadError` (not a native `TypeError`) on `1n`/`Symbol()`, still before any network call.
- **Regression proof:** temporarily reverting the guard to the unconditional-`JSON.stringify` form makes the `1n` pin **fail** (a native `TypeError` is not a `HeadShaCertificationError`) — confirming these are genuine regression pins, not incidental passes.

### NIT 2 — a false adapter contract

`ForgeAdapter.resolveRefCommit` promises a **certified 40-hex** commit identity on both sides of a freshness equality; `GitHubForge` and `LocalGitForge` enforce it by construction, but **`MemoryForge.resolveRefCommit` returned its `refs` fixture bytes unchecked** — a fixture returning garbage would seed an uncertified SHA into an equality the AMAS corpus is meant to exercise honestly.

**Fix (`packages/kernel/src/forge/memory.ts`):** certify the fixture SHA with the same `/^[0-9a-f]{40}$/` regex and throw the forge-layer `TreeParseError` on malformed — exactly as the other two adapters. New `packages/kernel/test/memory-forge.test.ts` pins that a non-40-hex fixture value **throws `TreeParseError`, not returns `ok`** (seven malformed shapes), plus the `ok`/`absent`/`unsupported` happy paths.

### PMN-001 — cross-family caught what same-family rated acceptable, again

The BigInt pin sailed through the Builder's self-check and the Architect's same-family re-gate (both rated it acceptable); the **cross-family (Codex) reviewer caught it**. This is the **second consecutive task on this trust boundary** where cross-family review found a defect same-family review missed (the first: [1]'s uncertified-`prHeadSha` BLOCK). PMN-001's required-red-team-gate discipline for the coverage/base/tier/trust-boundary surface is reaffirmed — its sunset trigger has **not** fired.

---

## 4. Contracts handed to [0] and [3] (recorded, not implemented here)

Inherited from [2] §7 and reaffirmed:

- **Catch-all — any throw blocks.** `forgePolicySource` (now freshness-bound) may throw `BranchFreshnessError`, `HeadShaCertificationError`, `PolicyReadError`, **or** a propagated forge-layer error (`TreeParseError`, `HttpError`). No caller may assume a single class.
- **Base-mismatch.** The Gate MUST assert `pull_request.base.ref === protectedBranch` and block on mismatch; the PR base is never the policy source.
- **NEW [0] CONTRACT — strict required-checks. When [0] wires `quorum-verify` it MUST set `strict_required_status_checks_policy: true`.** A *non-strict* required check is **the false-fresh vector wearing a green tick**: it passes against a stale fork's own snapshot and the PR merges anyway. Strictness is what makes the **forge itself** enforce up-to-date at merge time, backstopping both the grade-to-merge race and our own (verification-time) read. Without it the Gate is *incomplete*, not merely less convenient. This is the enforcement half [2] does not ship (§2).
- **Route to [3] — the check to promote.** The existing advisory workflow `ci` (job **`build-test`**) already triggers on `pull_request` (good) and is the likely candidate for [0] to register as the required `quorum-verify` check. Its bytes need **[3] review** before promotion: it currently uses **tag-pinned, not SHA-pinned, actions** (`actions/checkout@v4`, `actions/setup-node@v4`) and `cache: npm` — a required check promoted from a PR-influenceable workflow (mutable action tags, PR-influenced cache/artifacts) would undermine the "unspoofable" property. Promotion is a [3]/[0] decision, not this task's.
- **Residual — supply-chain, tracked for [3], not this task.** `npm audit` on a clean install reports **5 vulnerabilities (3 moderate, 1 high, 1 critical)** in the dev/build toolchain (e.g. `vite-node`/`vitest`). Recorded as a trusted/pinned-verifier ([3]) residual; it does not bear on the kernel's runtime trust surface (`@octokit/rest` + `@quorum/contracts`) and is out of scope here.

---

## 5. §3.3 supersession of the [1] `forgePolicySource` contract

`docs/handoffs/QRM-4.0-policy-read-review.md` describes `forgePolicySource` as it shipped in #21 — accurate when written. **[2] changes its contract: it is now freshness-bound** (calls `assertBranchFreshness` internally; grades only against the fork point an up-to-date protected branch yields; the stale-fork / old-permissive-policy channel [1] deferred to [2] is closed structurally). Per the design's supersession note, the [1] record is **not** edited — the supersession is recorded here and in git history. This was safe to do now precisely because [1] shipped `forgePolicySource` with **zero forge-mode callers**, so there was no caller to break.

---

## 6. Verification at hand-back

- **Clean rebuild green:** `npm run build` (contracts + kernel) clean; **`npx vitest run` → 389/389 passed (28 files)**. Baseline was 375; this fix delta adds +14 (branch-freshness +2: `1n`, `Symbol()`; policy-source +2: BigInt/Symbol backstop; new `memory-forge.test.ts` +10).
- **New error class:** `HeadShaCertificationError` (exported from `packages/kernel/src/index.ts`).
- **Not done, by instruction:** the per-task manifest is **not** flipped to `merged` (the enforcement half is unshipped — [2] is not satisfied); `QRM-4.0.json` is untouched (frozen spec); the untracked `.claude/` agent-config dir is not staged; PR #24 stays **draft**.

---

## 7. Position on the QRM-4.0 board after this task

Prerequisite **[2]** — **kernel half satisfied, enforcement half open.** Board: **[5]** compare parity ✅, **[11]** authenticated listFiles ✅, **[7]/[8]** delegated references ✅, **[1]** authenticated base-policy read ✅ (now freshness-bound), **[2]** kernel ✅ / enforcement ⛔ (needs strict required checks at [0]). Remaining before the Gate is real: **[3]** trusted/pinned verifier, then **[0]** wires `quorum-verify` as a **strict** required check — which is also what finally satisfies [2]. The CLI stays `--local` until [0] routes forge mode into the enforcement path.
