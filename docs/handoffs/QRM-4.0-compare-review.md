# QRM-4.0-compare — task review record

**Task:** GitHubForge.compare parity (tree-diff-primary) + authenticated listFiles + resolveEnforcement extraction.
**Merge base:** `cd951d9` (main). **Branch:** `qrm-4.0-compare-parity`. **Final tip re-gated & merged:** `373fbd4`.
**Diff from base:** 12 files, +1161/−70. **Suite at merge:** 295/295 across 25 files (219 pre-existing baseline preserved).
**Tier:** T3 (forge trust boundary). **Builder:** Claude Opus 4.8, xhigh (reported at hand-back). **Cross-family red-team:** Codex (GPT). **Cross-architect design review:** GPT.

This record is the committed history of the task so the arc is not chat-only (principle: verify, don't trust; git is source of truth).

## What shipped

`GitHubForge.compare` and `.listFiles` are now real (they previously threw / returned `unsupported`). The mode-bearing diff is derived from **recursive git trees** at base and head — never from GitHub's REST compare `files[]`, which carries no git object modes and truncates at ~300 files with no deterministic signal. The parity contract: `GitHubForge.compare` yields the same changed-path SET (both rename sides) and the same per-path git object MODES as `LocalGitForge.compare` (the `git diff --raw -M -z` oracle); rename-vs-(add+delete) attribution need not match and does not, by construction. This holds because no enforcement consumer reads `DiffEntry.status` or `oldPath` — only the flat changed-path set and `newMode` (verified at `cd951d9`).

`resolveEnforcement` was extracted from `cli.ts` into a kernel module behind a `PolicySource` seam: enforcement reads policy and resolves references at the canonical fork point; the `--policy=head` diagnostic keeps its working-tree-policy + references-at-HEAD semantics; forge mode exposes no working-tree diagnostic. Local-mode behavior is byte-identical (the 219 baseline stayed green).

`listFiles` is now backed by the same recursive-trees surface — prerequisite [11], which is what makes QRM-3.4's delegated-reference floors actually hold in forge mode rather than merely stop failing.

## Scope — claimed and explicitly not claimed

Satisfies QRM-4.0 prerequisites **[5]** (GitHubForge.compare parity) and **[11]** (authenticated listFiles), and unblocks **[4]** (Gate consumes a mode-bearing diff). Does **not** claim [1] (authenticated base-policy read wiring), [2] (branch-freshness), [3] (trusted/pinned verifier), or the L2 Gate itself (item [0]). The CLI remains `--local`; this task builds the forge-mode capability without routing to it (principle: don't claim enforcement not shipped).

## First-party confirmations (B1–B3, recorded before implementation)

Confirmed against real GitHub REST bytes; none diverged from the design's assumptions. B1: trees API returns `path/mode/type/sha` per entry and a top-level `truncated` boolean; accepted `(type,mode)` pairs `blob`→{100644,100755,120000}, `commit`→160000, `tree`→040000, no cross-pairings; commit→tree resolved explicitly via `commit.tree.sha` (endpoint leniency toward commit SHAs recorded but not relied on). B2: compare top-level `status` ∈ {ahead,behind,identical,diverged}. B3: `truncated` is the sole overflow signal — no count field — confirmed firing on a real over-limit tree (torvalds/linux). **Auth caveat, carried to [3]:** B1–B3 used a `gho_` user token, not an App installation token — response *shape* is token-independent (so the parity contract holds), but App-permission-specific tree readability (e.g. a private submodule's gitlink tree under the App's grants) is unproven until the real App is wired at [3]. Recorded as a [3] checklist item, not a re-do.

## Review arc

**Design.** `docs/handoffs/QRM-4.0-compare-design.md` (v2). GPT cross-architect review returned "accept with mandatory amendments"; all five adjudicated ACCEPTED after independent byte-verification: (1) envelope semantics — `absent()` on unresolvable ref, throw on malformed-data-received, and the new-contract rule that any non-`ok` compare result blocks at the Gate (verified no enforcement path consumed the envelope at `cd951d9`, so this task defines it); (2) `PolicySource` seam preserving `--policy=head` working-tree semantics, with a dirty-tree regression test; (3) pairwise `(type,mode)` validation, not independent field checks; (4) adversarial malformed-tree fixtures; (5) `listFiles` parity as a separate acceptance-level assertion. Architect prototype de-risked the core algorithm 13/13 against the real `parseRawDiff` before the Builder ran.

**Implementation `6f71603`.** Architect re-gated from committed bytes: fail-closed parser, envelope semantics, the `PolicySource` seam (dirty-tree regression confirmed *executed*, not skipped), and 276/276 from a clean rebuild.

**Codex red-team round 1 (`6f71603`):** 1 BLOCK, 1 concern, four surfaces probed clean.
- **BLOCK — malformed `truncated` under-floor (fails open).** `parseTreeLeaves` failed only on `res.truncated === true`; a non-boolean/missing flag (`"true"`, `"false"`, `null`, `0`, missing) fell through and a partial tree was accepted → a symlink/gitlink leaf could vanish from both maps → under-floor.
- **Concern — compare triple not bound to resolved commits (fail-open if mutable refs reach compare).** `compare` passed the caller's raw refs to `compareStatus`, discarding the resolved `commitSha`, so a moved ref / misbehaving API could yield a head tree from one commit and a status from another.
- Probed clean: `(sha,mode)` parity, `isNotFound` fail-closed on non-404s, `listFiles`→`ReferenceResolutionError` propagation, `PolicySource` fork-point binding.

**Adjudication (Architect + Owner).** BLOCK ACCEPTED, scoped: certify `truncated` as a strict boolean (missing/non-boolean → throw; true → throw). The *honest* near-cap case is unreachable at Quorum's scale (linux tripped `truncated` at ~72k entries; Quorum is a few hundred files); the *compromised-forge* case (well-formed `false` on a fabricated-short tree) is outside single-source defense — Quorum reads compare, commit, and tree all from the same forge, its only oracle (principle 5) — and is documented in-code as a boundary assumption, not silently accepted. The non-recursive per-subtree walk was **declined**: it does not close the compromised-forge case (a lying API lies per subtree) and adds O(directories) trust-boundary surface; tracked as a scale/durability residual for the Fable 5 architectural pass, to revisit only if a consumer repo approaches the tree-size cap. Concern ACCEPTED and elevated to must-fix-in-same-pass: bind `compareStatus` to the resolved commit SHAs so the (baseTree, headTree, status) triple is consistent by construction — "the future Gate will pass immutable SHAs" is an unenforced invariant, and no forge-mode caller exists yet, so the method is made safe by construction rather than by discipline.

**Fix delta `373fbd4`.** Fix 1: strict-boolean certification, type-check ordered before the truncated-true case, plus the honest trust-boundary comment (no walk, no count heuristic). Fix 2: `compare` resolves each ref once via `resolveTreeSha`, fetches trees by content-addressed `treeSha` (new `fetchTreeLeaves`), and passes resolved `commitSha` values to `compareStatus`; `listFiles` shares the resolve-then-fetch path. Tests: the six `truncated`-flag variants throw through parser/compare/listFiles, and a deterministic spy asserts `compareStatus` receives `${baseCommitSha}...${headCommitSha}` (not raw refs). Test-integrity fix caught by the Builder: pre-existing content-malformation fixtures gained `truncated: false` so they still reach their intended check rather than short-circuiting on the new guard; `PathNormalizationError` cases kept distinct. Suite 276 → 295.

**Codex focus re-review (`6f71603..373fbd4`):** both prior findings confirmed closed; no new BLOCK/concern/nit. Independently re-ran the malformed-`truncated` repro (8 variants, symlink + gitlink leaves present) through all three surfaces — all throw — with a positive `truncated:false` control preserving modes 120000/160000; re-ran the TOCTOU repro and observed `base-resolved-commit...head-resolved-commit`, not `BASE...HEAD`; confirmed the envelope intact after the `fetchLeaves` split.

**Independent clean-clone verify (Architect).** Fresh clone of the branch at `373fbd4`, clean install + `dist/` rebuild from scratch, full suite **295/295**. The live authenticated GitHubForge-vs-LocalGitForge parity run (three real quorum spans — compare set+modes and listFiles both matching the local oracle) was executed and recorded by the Builder under auth and confirmed by Codex; not re-run in the token-less clean clone (honest status).

## Residuals tracked (not closed here)

- **Single-source completeness boundary.** A compromised forge returning a well-formed `truncated:false` on a fabricated-short tree is undefendable by a single-source verifier; documented in-code. Non-recursive-walk hardening deferred to the Fable 5 architectural-durability pass, gated on a consumer repo approaching the tree-size cap.
- **[3] App-token confirmation.** B1–B3 used a user token; App-permission-specific tree readability (private submodule gitlinks under App grants) to be confirmed when the `quorum-gate` App is wired at [3].
- **R1.** `resolveCommit`'s delta-membership check reads a single unpaginated compare `commits[]` page; a >250-commit branch can misread a pushed commit as `absent` — blocks, never under-floors. Fix rides any later touch of that path.

## Position on the QRM-4.0 board after this task

[5] and [11] satisfied; [4] unblocked. Remaining Gate prerequisites: [1] authenticated base-policy read, [2] branch-freshness, [3] trusted/pinned verifier (+ its cache-poisoning amendment, ratified and landing with this task's bookkeeping), then wire [0]. The `quorum-gate` GitHub App remains the longest-lead item, provisioned in parallel on the Owner's account. The Fable 5 two-pass audit (adversarial whole-system + architectural durability) sits at the QRM-4.0 boundary, after all prerequisites land and before the L2 Gate goes live.
