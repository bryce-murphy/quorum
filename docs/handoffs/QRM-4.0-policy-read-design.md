# QRM-4.0-policy-read — design doc

**Task:** Forge-mode authenticated base-policy read (QRM-4.0 prerequisite **[1]**).
**Base:** `main` at `5ffba77`. **Merge base of this work:** `5ffba77` (resolve live at branch time).
**Tier (proposed):** **T3** — policy provenance is a trust boundary; a wrong policy silently re-floors every subsequent grade.
**Rides on:** QRM-4.0-compare ([5]/[11] — authenticated `GitHubForge` + `resolveTreeSha`/`getFile`) and QRM-3.2 (`loadPolicyAtRef` local semantics) and QRM-3.4 (`PolicySource` seam in `enforcement.ts`).
**Status:** DESIGN v2 — GPT review "accept with mandatory amendments" (all six ACCEPTED, two strengthened after byte-verification, folded in below); **Architect prototype P1–P5 complete and passing against real bytes** (§7.1). **Builder-ready.** Route per §7 of the handoff: **T3, Sonnet xhigh** (primitives now proven to exist, so not novel/adversarial — no Opus escalation indicated).

**GPT adjudication (all verified against committed bytes at `5ffba77`; verify-don't-trust — GPT advises, the repo decides):**
1. **SHA-shape (40-hex) certification** — ACCEPTED. The single-SHA binding is only sound if the SHA is immutable; a `main`/short-SHA value would reintroduce ref resolution downstream. Folded into §3/§4/§8, with a P5 negative.
2. **`prHeadSha` not `headRef`** — ACCEPTED. Verified: `getPR` exposes `headSha` (github.ts:138); `PrInfo` carries no fork owner/repo, so an unqualified branch label is mutable and not fork-unique. Signature changed. Does not claim [2].
3. **PR-base-mismatch as inherited [0] contract** — ACCEPTED. Promoted from note to a recorded (not implemented) [0] contract in §5/§8.
4. **Stale-fork residual under [2]** — ACCEPTED. Real branch-freshness path; [1] reads the fork point (preserving QRM-3.2 merge-base grading), [2] closes staleness via require-up-to-date-branches. Added to §10; the "pin is sufficient" framing removed.
5. **Encoding fix stays in-task + reference-config test** — ACCEPTED, **strengthened**. Verified the under-floor is real and sharper than GPT stated: `extractClaudeMdReferences("")` → zero refs, no throw, so an empty `CLAUDE.md` silently under-floors. Fix stays in-task; acceptance requires the `CLAUDE.md` encoding test.
6. **Symlink "byte-identical" correction** — ACCEPTED, **corrected via first-party check**: `git show <ref>:path` on a symlink returns the *link target text* (not followed content), so local *also* blocks — incidentally, via `JSON.parse` failure. Both fail closed; wording changed from "byte-identical" to "behaviorally equivalent" (§0/§4.3/§6); explicit local non-file rejection tracked as an optional residual (§10).

---

## 0. One-sentence scope

Give the `PolicySource` seam its **forge implementation**: resolve the canonical fork point to a commit SHA via the authenticated compare API's `merge_base_commit.sha`, read `.quorum/policy.json` at that SHA through `GitHubForge.getFile`, validate it with `PolicySchema`, and hand `resolveEnforcementK` a `{ policy, referenceRef }` bound to that one resolved SHA — mirroring QRM-3.2's local `loadPolicyAtRef(canonicalForkPoint)` semantics (behaviorally equivalent — both fail closed; §4.3 corrects an earlier "byte-identical" overclaim), fail-closed on every unresolvable/unreadable/malformed path.

## 1. What [1] is, and what it is NOT

Manifest item [1] verbatim: *"the Gate's forge-mode path reads `.quorum/policy.json` from the authenticated PR base event (merge-base), never the PR head (forge-mode counterpart of QRM-3.2's local fix)."*

**Claims:** [1] only. Builds the forge-mode policy-provenance capability behind the existing `PolicySource` seam.

**Does NOT claim** [2] (branch-freshness), [3] (trusted/pinned verifier), [0] (wiring `quorum-verify` as a required check / the L2 Gate). The CLI stays `--local`; **no forge-mode caller is routed to** by this task. This builds the capability; wiring is [0]. (Principle 2: don't claim enforcement not shipped.)

**Determinism line:** everything here is deterministic code reading committed bytes from a resolved commit SHA. No judgment, no LLM. It floors.

## 2. The local semantics this must mirror (QRM-3.2 / 3.4, read at `5ffba77`)

`cli.ts` enforcement path (non-diagnostic branch):

```
const referenceRef = canonicalForkPoint(cwd);              // = merge-base(HEAD, main), git
const source = { policy: loadPolicyAtRef(referenceRef, cwd), referenceRef };
return resolveEnforcementK(source, new LocalGitForge({ cwd }), diffEntries);
```

`loadPolicyAtRef` (cli.ts:173) does, in order, all failing **closed** to the protocol/block exit:
1. `git show <ref>:.quorum/policy.json` → `null` ⇒ **block** ("policy not found at ref").
2. `JSON.parse` throws ⇒ **block** ("not valid JSON").
3. `PolicySchema.safeParse` fails ⇒ **block** (first issue message).

The forge counterpart must reproduce **exactly these three gates**, plus the forge-specific ones §4 adds, and must resolve `referenceRef` to the **same** commit SHA the policy is read from (so policy, delegated references (`resolveReferencedFloors`), and — later — commit-membership all grade at one fixed SHA; §3).

## 3. Design — `forgePolicySource`

A new async kernel helper, colocated with the `PolicySource` seam it feeds (proposed `packages/kernel/src/enforcement.ts`, or a sibling `policy-source.ts` if the seam file should stay dependency-light — GPT to opine):

```
async function forgePolicySource(
  forge: GitHubForge,
  protectedBaseBranch: string,  // the PINNED protected branch — §5, NEVER from the PR object
  prHeadSha: string,            // the authenticated PR head COMMIT SHA — §4.6, not a mutable branch label
): Promise<PolicySource>
```

**Head identity is a commit SHA, not a branch label (GPT amendment 2).** `GitHubForge.getPR` already exposes `headSha` alongside `headRef` (adapter.ts:35, github.ts:138); `PrInfo` carries no fork owner/repo, so an unqualified `headRef` branch name is both mutable and — for fork PRs — not globally unique. The merge-base is therefore resolved against the immutable, authenticated PR head **commit SHA** the event named (`protectedBaseBranch...prHeadSha`), never a collidable/mutable branch label. This does **not** claim branch-freshness [2] — it only ensures the fork point is computed against the head commit the event actually named; [2] later proves that commit is still the PR head.

Sequence, all fail-closed:

1. **Resolve the canonical fork point to a commit SHA.** Call compare `protectedBaseBranch...prHeadSha`, read `merge_base_commit.sha`. Confirmed live under auth this session: `status: ahead | merge_base_commit.sha: cd951d913094…` (full 40-char SHA). **The value must be certified as a full 40-hex commit SHA before use (GPT amendment 1)** — missing, non-string, short/ambiguous (`abc123`), or branch-like (`main`, `refs/heads/main`) all ⇒ **throw** (block). This certification is load-bearing, not cosmetic: the entire single-SHA binding (§3, below) depends on `referenceRef` being *immutable*. A merely-string value that is actually a mutable ref would reintroduce ref resolution inside every downstream `getFile`/`listFiles` and silently defeat the TOCTOU guarantee. This is `canonicalForkPoint`'s forge analog — and it is the **only** correct source of the fork point (§5 explains why not `pr.base.sha`).
2. **Read policy at that resolved SHA.** `forge.getFile(mergeBaseSha, ".quorum/policy.json")`.
   - `absent` (404, or non-file type — e.g. a **symlinked** policy) ⇒ **throw** (block). Never default. (§4.3)
   - `ok` ⇒ have raw UTF-8 content + sha256 of raw bytes.
3. **Parse + validate**, reusing the *same* `PolicySchema` the local path uses (import from `@quorum/contracts`, do not re-declare):
   - `JSON.parse` throws ⇒ **block**.
   - `PolicySchema.safeParse` fails ⇒ **block** (first issue message, parity with local text where practical).
4. **Return** `{ policy, referenceRef: mergeBaseSha }`. `referenceRef` is the **resolved commit SHA**, never `baseBranch` or a caller ref — so `resolveReferencedFloors(policy, forge, referenceRef)` reads delegated configs from the identical commit the policy came from. TOCTOU between "resolve fork point" and "read policy/refs" is structurally impossible: one SHA, threaded everywhere.

**The compare-triple pattern, applied to [1].** QRM-4.0-compare bound `(baseTree, headTree, status)` to two resolved commit SHAs so a moving ref couldn't split the read. The same discipline here: `(policy blob, delegated-reference tree, referenceRef)` all bind to the single `mergeBaseSha`. Resolve once, pin everywhere.

## 4. Fail-closed surface (the T3 core)

### 4.1 `getFile` encoding gap — MUST fix in this pass (new BLOCK-class finding)

`GitHubForge.getFile` (github.ts:70) currently does `Buffer.from(data.content, "base64")` **without checking `data.encoding`**. The contents API returns `encoding: "none"` with empty `content` for blobs > 1 MB. Today that path fails closed only **by accident** — empty content → `JSON.parse` throws → block. QRM-4.0-policy-read is the **first task to put `getFile` on the enforcement trust path**, so this must become fail-closed **by construction**, mirroring the strict-boolean `truncated` certification from 4.0-compare:

> `getFile`: if `data.encoding !== "base64"` (missing, `"none"`, or any other value) ⇒ **throw** (do not attempt to decode). A blob we cannot read as base64 is unreadable enforcement input, not an absence.

This is a change to a shared primitive; the `absent`-on-404 and non-file-type behavior stays.

**The real blast radius is the reference path, not policy JSON (GPT amendment 5 — verified against bytes this session).** For `.quorum/policy.json`, `encoding:"none"` yields empty content and `JSON.parse` blocks — an *accidental* block, but a block. For a reference-bearing config it is worse: `resolveReferencedFloors` reads matched configs through `getFile`, and `extractClaudeMdReferences` over **empty** content returns **zero references, not a parse failure** (confirmed: `parseClaudeImports("")` → `[]` → `exact: []`, no throw). So a >1 MB `CLAUDE.md` returning `encoding:"none"` would silently resolve **zero delegated floors** — a genuine **under-floor**, the worst outcome under this program's calibration (a wrong verified claim reaching an athlete/coach). The strict-encoding certification converts that silent under-floor into an explicit block.

Because the under-floor lives on the reference path, the fix stays **in this task** (not a standalone PR): [1] is the first task to put `getFile` on the enforcement trust path, and splitting the hardening would ship `forgePolicySource` while leaving an accidental decoder on the reference path the same enforcement composition already walks. Acceptance (§8) therefore requires strict-encoding tests for **both** `.quorum/policy.json` **and** at least one reference-bearing config (`CLAUDE.md`), the latter proving `encoding:"none"` **throws/blocks** rather than resolving zero references. Codex will probe both as under-floor vectors.

### 4.2 Base-branch pinning — see §5 (the R1-analog; single highest-risk item)

### 4.3 Symlinked / non-file policy at the fork point (and the local-symmetry correction)

`getFile` returns `absent` for `Array.isArray(data)` (directory) or `data.type !== "file"` (submodule/symlink). `forgePolicySource` treats `absent` as **fatal** (throw/block), never a default policy. A `.quorum/policy.json` that is a symlink at the fork point ⇒ block. Pin with a test (mocked `getContent` returning `type:"symlink"`).

**Both modes block a symlinked policy, but by different mechanisms — the "byte-for-byte / byte-identical" wording in §0 and §6 is corrected accordingly (GPT amendment 6).** First-party confirmed this session: `git show <ref>:.quorum/policy.json` on a symlink returns the **link target text** (e.g. `../realdir/actual-policy.json`), not the followed file content. So local `loadPolicyAtRef` feeds that string to `JSON.parse` → throws → **blocks** — an *incidental* fail-closed (parse failure on the link text), whereas forge's block is *explicit* (`absent` on non-file type). Enforcement outcome is equivalent (both block); mechanism is not. Wording corrected from "byte-identical" to "behaviorally equivalent (both fail closed)." Local's incidental block is exactly the accidental-fail-closed pattern this program dislikes; making local `loadPolicyAtRef` reject non-file tree entries *explicitly* is a small optional hardening, tracked as a residual (§10), **not** required for [1].

### 4.4 Content integrity is content-addressed, not path-addressed

The policy is read at a resolved **commit SHA**, and `getFile` hashes the **raw decoded bytes** (sha256, already implemented). The design does not trust the path or the branch name — it trusts the bytes at the resolved commit. (Single-source completeness boundary from 4.0-compare still applies: a compromised forge is out of single-source scope; documented, not silently accepted.)

### 4.5 Envelope discipline

Every non-`ok` forge response on this path ⇒ block. No partial policy, no default, no "fall back to head." Consistent with `resolveReferencedFloors` (which already throws `ReferenceResolutionError` when the tree can't be enumerated at `referenceRef`).

## 5. The R1-analog — base-branch retargeting (design's load-bearing decision)

**Local R1 (QRM-3.2, closed):** the fork point was pinned to `main`, NOT the `--base`-overridable diff base, so a PR couldn't point enforcement at a permissive policy by moving the diff base.

**Forge R1 (this task must close it one level up):** a GitHub PR's **base branch is retargetable by the PR author**. If `forgePolicySource` computes merge-base against `pr.base.ref` / `pr.base.sha` (from the PR object / webhook payload), an attacker opens the PR against a throwaway branch carrying a permissive `.quorum/policy.json`, and every tier floor collapses — a silent under-floor, the single worst outcome under conservative calibration (a wrong verified claim can reach an athlete/coach).

**Decision (firm):** `baseBranch` is a **verifier-configuration constant** — the repository's protected default branch, fixed in the Gate's own config, **read from the verifier's trusted context, never from the PR event's `base` field.** The PR head is used only as the *head* argument to merge-base resolution; the base is pinned. This is the forge translation of "pin to main, not the overridable base," and it is the item most likely to draw a Codex BLOCK if the design or implementation drifts. Prototype and test must both demonstrate that a PR-supplied base is ignored.

**Inherited [0] contract (GPT amendment 3 — promoted from note to required).** Ignoring `pr.base.ref` for policy provenance is *necessary* (it stops attacker-chosen policy sourcing) but not *sufficient* for the eventual Gate: a PR targeted at some non-protected branch must not receive a "verified against the protected default branch" decision as if that non-protected branch were the merge target. This task scopes [1]'s implementation to the pinned `protectedBaseBranch`, and **records the following as a hard contract [0] must satisfy when the Gate is wired** (recorded here, not implemented in [1]):

> **[0] contract:** The Gate MUST assert `pull_request.base.ref === protectedBranch`; a mismatch **blocks**. The PR base is never used as the policy source.

Called out as an inherited required contract so [0] enforces it rather than rediscovering it.

## 6. Where it plugs in (seam, unchanged)

`resolveEnforcementK(source, repoReader, diffEntries)` in `enforcement.ts` is **untouched** — it already accepts any `PolicySource` + any `ForgeAdapter`. This task only adds the forge *constructor* of `PolicySource` and passes `GitHubForge` as `repoReader`. Local mode's `resolveEnforcement` in `cli.ts` is **byte-identical** after this change (the 295 baseline must stay green — local's code path does not change at all). Forge mode is **behaviorally equivalent** to local at the enforcement outcome (both fail closed on absent/bad-JSON/schema-fail/non-file policy), not byte-identical in mechanism (§4.3). No CLI routing to forge mode (that's [0]).

Symmetry check the implementation must preserve:

| | Local (QRM-3.2/3.4, shipped) | Forge (this task) |
|---|---|---|
| fork point | `canonicalForkPoint(cwd)` = `git merge-base` | compare `merge_base_commit.sha`, base **pinned** (§5) |
| policy read | `loadPolicyAtRef(ref)` = `git show ref:.quorum/policy.json` | `getFile(mergeBaseSha, ".quorum/policy.json")` |
| absent | `null` ⇒ block | `absent` ⇒ throw/block |
| bad JSON | block | block |
| schema fail | block | block |
| `referenceRef` | the fork point | the resolved `mergeBaseSha` |
| repoReader | `LocalGitForge` | `GitHubForge` |

## 7. Prototype / de-risk plan (Architect, before Builder — against real bytes)

Under the `gho_` token (App-token confirmation stays a [3] residual, §10):

1. **P1 — merge-base shape under auth.** ✅ done this session: compare `merge_base_commit.sha` returns a full 40-char SHA (`cd951d913094…`). Re-run at branch time against the branch's actual base/head to confirm shape holds for a live PR-shaped span.
2. **P2 — `getFile` at resolved SHA.** Read `.quorum/policy.json` at `mergeBaseSha` via the real API, assert content parses under `PolicySchema` and the sha256 matches `git show`'s bytes (cross-check the forge read against the local oracle — the parity discipline).
3. **P3 — encoding gap repro (both surfaces).** Fetch a real >1 MB blob's `getContent` response, confirm `encoding:"none"` today decodes to empty. Then confirm the §4.1 guard throws for **policy JSON** *and* — the sharper case — for a **reference-bearing `CLAUDE.md`**, where empty content otherwise resolves zero references (a silent under-floor) rather than blocking.
4. **P4 — base-pinning negative.** Construct the retargeting scenario (a branch with a permissive policy as a candidate base) and confirm `forgePolicySource` with a pinned `protectedBaseBranch` ignores it.
5. **P5 — SHA-shape negative (amendment 1).** Confirm `forgePolicySource` rejects a `merge_base_commit.sha` that is branch-like (`main`), short/ambiguous, non-string, or missing — each throws before any `getFile`/`listFiles` runs.

### 7.1 First-party confirmations (P1–P5, recorded before implementation)

Executed against real GitHub bytes under authenticated `gh` (`@bryce-murphy`) and the live `bryce-murphy/quorum` clone at `E:\quorum`, `main` = `5ffba77`. Read-only; no writes/PRs. None diverged from design v2's assumptions.

- **P1 — merge-base shape.** ✅ compare `<main~1>...<main>` → `merge_base_commit.sha = cd951d913094b5023acfdc992991eadcbf6d223d`, a full 40-hex commit SHA, `status=ahead`. Confirms the forge fork-point analog and the certification target for amendment 1. (No non-`main` remote branch existed, so the live-PR-span variant was skipped; the synthetic span exercises the same `merge_base_commit.sha` field.)
- **P2 — forge read == local oracle, and parses.** ✅ `getContent(.quorum/policy.json @ mergeBaseSha)` decoded bytes sha256-match `git show <mergeBaseSha>:.quorum/policy.json` exactly (`20a56004d9a9…`); content parses as JSON with a `rules[]` array of 72 entries. Confirms `getFile`-at-resolved-SHA is byte-faithful to committed bytes — the parity the `PolicySource` forge implementation rests on.
- **P3a — encoding guard (deterministic).** ✅ The strict `encoding !== "base64"` guard throws on GitHub's `encoding:"none"` shape. Unguarded, the two current fall-throughs are confirmed: policy JSON blocks *by accident* (`JSON.parse("")` throws), but a `CLAUDE.md` yields **zero references, no throw** — the silent under-floor. Confirms the fix is load-bearing specifically on the reference path (amendment 5).
- **P3b — real >1MB `encoding:"none"`.** ⏭ SKIPPED (no stable >1MB sample reachable this run). Non-blocking: P3a proves the guard logic deterministically; live re-confirmation can ride the Builder's authenticated test run if desired. Tracked, not a gap.
- **P4 — base pinning is load-bearing.** ✅ On real history, base choice moves the fork point: pinned base → merge-base `3492100e…`, attacker-chosen base → `04c00da1…` (distinct). The modeled `forgePolicySource` passes **only** the pinned base to compare; the attacker base is not a parameter it reads. Confirms §5's pin is not theoretical.
- **P5 — SHA-shape guard.** ✅ The 40-hex guard accepts the valid SHA and throws on all 10 bad shapes (branch-like `main`/`refs/heads/main`, short, empty, `null`, `undefined`, uppercase, non-hex, wrong length). Confirms amendment 1 is implementable exactly as specified.

**Net:** all load-bearing assumptions hold against real bytes. Clear to route to Builder. Auth caveat carried, unchanged from 4.0-compare: prototype used a `gho_` user token via `gh`; App-installation-permission behavior for `getContent`/compare at the merge-base under the real `quorum-gate` grants is confirmed when the App is wired at [3] (§10).

## 8. Acceptance (what the Builder delivers)

1. `forgePolicySource(forge, protectedBaseBranch, prHeadSha)` returning a `PolicySource` bound to the resolved merge-base SHA, all §4 gates fail-closed. Head identity is the immutable PR head **commit SHA**, not a branch label (amendment 2).
2. **`merge_base_commit.sha` certified as a full 40-hex commit SHA** (amendment 1): missing / non-string / short-or-ambiguous / branch-like (`main`, `refs/heads/main`) all → throw. Tests for each.
3. `getFile` strict-encoding certification (§4.1) with throwing tests for `encoding:"none"` on **both** `.quorum/policy.json` **and** a reference-bearing config (`CLAUDE.md`) — the latter proving it blocks rather than resolving zero references (amendment 5).
4. Tests: unresolvable base/head → throw; policy absent → throw; symlinked/non-file policy → throw; bad JSON → block; schema-fail → block; **PR-supplied base ignored** (§5); happy path returns `referenceRef === mergeBaseSha` (a 40-hex SHA).
5. Local-mode code path unchanged; the 295 baseline stays green; suite grows only by new cases. Forge mode is behaviorally equivalent, not byte-identical (§4.3/§6).
6. **Recorded (not implemented) [0] contract** (amendment 3): the review record states the Gate must assert `pull_request.base.ref === protectedBranch` and block on mismatch.
7. `docs/handoffs/QRM-4.0-policy-read-review.md` records the full arc — this GPT adjudication and the two carried residuals (stale-fork under [2]; local non-file incidental block).

## 9. Loop (per §3 of the handoff)

design (this doc) → **GPT cross-architect review** → Architect prototype/de-risk (§7) → Builder (route §7 of handoff — likely **T3, Sonnet xhigh**; escalate to Opus 4.8 only if the base-pinning proves novel/adversarial in prototype) → Architect re-gate from committed bytes → **Codex red-team** (mandatory, trust boundary — the encoding gap and base-pinning are the two named probe targets) → clean-clone verify → PR → Bryce squash-merge (manual body, no `Co-Authored-By`) → T0 bookkeeping.

## 10. Residuals this task carries (not gaps to re-find)

- **[3] App-token confirmation.** Prototype uses a `gho_` user token; App-installation-permission behavior for `getContent`/compare at the merge-base under the real `quorum-gate` grants is confirmed when the App is wired at [3]. (Same carry as 4.0-compare B1–B3.)
- **Base-branch source at wiring time.** This task pins `baseBranch` as a parameter/config constant; the actual verifier-config plumbing (how the Gate learns the protected branch, and blocks mis-targeted PRs) lands with [0]. Called out in §5 so [0] inherits it.
- **Stale-fork / old-policy path — carried by [2], not closed by [1] (GPT amendment 4).** The base pin (§5) closes PR *retargeting*, but not this branch-freshness path: (1) protected `main` has a permissive policy at commit A; (2) attacker branches from A; (3) `main` later tightens `.quorum/policy.json` at commit B; (4) the attacker PR's pinned merge-base against `main` remains A; (5) `forgePolicySource` correctly reads policy at A — permissive relative to current `main`. This is **not** a leak in the pin: [1] deliberately preserves QRM-3.2's local semantics — it reads the **canonical fork point (merge-base)**, *not* the current protected-branch tip — which is the "merge-base grading" property (a PR is graded against where it forked, so a concurrent tightening on `main` cannot retroactively re-grade a PR mid-review). The staleness is closed by **[2] mechanical branch-freshness** (require-up-to-date-branches): forcing the branch current drags the fork point forward from A to B before merge. [1] must not claim to close this; it is [2]'s job, and the design reads the fork point precisely so [2] can close it cleanly. The design must not describe the pin as "sufficient" against this class.
- **Local non-file policy is an incidental (not explicit) fail-closed (§4.3).** Local `loadPolicyAtRef` blocks a symlinked policy via `JSON.parse` failure on the link target text, not via mode inspection. Making local reject non-file entries explicitly is a small optional hardening; tracked, not required for [1].
- **R1 (`resolveCommit` unpaginated `commits[]`).** Untouched here; still fails closed. Fix rides a later touch of that path (unchanged from 4.0-compare).
