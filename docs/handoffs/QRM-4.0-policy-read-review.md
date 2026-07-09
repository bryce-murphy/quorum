# QRM-4.0-policy-read — task review record

**Task:** Forge-mode authenticated base-policy read (QRM-4.0 prerequisite **[1]**) — the forge counterpart of QRM-3.2's local `loadPolicyAtRef`, giving the `PolicySource` seam its forge implementation.
**Merge base:** `5ffba77` (main). **Branch:** `qrm-4.0-policy-read`. **Final tip re-gated & merged:** `38e280b` (squash of PR #21, no `Co-Authored-By`).
**Diff from base:** 7 files, +735/−2 (kernel `policy-source.ts` +118, `forge/github.ts` +73, two one-line export threads, two test files +363, design doc +180).
**Suite at merge:** 334/334 (clean rebuild; the 295→318→334 baseline preserved additively).
**Tier:** T3 (policy provenance is a trust boundary — a wrong base policy silently re-floors every subsequent grade). **Builder:** Sonnet; effort not confirmed at hand-back (Claude Code interactive routing-report gap, recorded in the session handoff — routing is advisory and not attestable from committed bytes, so it did not bear on correctness here). **Cross-family red-team:** Codex (GPT). **Cross-architect design review:** GPT.

This record is the committed history of the task so the arc is not chat-only (principle: verify, don't trust; git is source of truth).

## What shipped

`packages/kernel/src/policy-source.ts` — `forgePolicySource(forge, protectedBaseBranch, prHeadSha)`. It certifies `prHeadSha` as full-lowercase-40-hex as its **first statement, before any network call**; resolves the fork point via `resolveMergeBase`; reads `.quorum/policy.json` at the resolved SHA via `getFile`; validates with `PolicySchema`; and returns `{ policy, referenceRef: mergeBaseSha }` bound to one resolved SHA. It fails closed on every path: bad head, unresolvable base/head, absent or non-file policy, malformed JSON, schema failure. It is sited as a sibling to `enforcement.ts` to keep the `PolicySource` seam dependency-light.

`packages/kernel/src/forge/github.ts` — `getFile` now throws `ContentEncodingError` on any non-`base64` encoding (it previously decoded `encoding:"none"` silently to empty — the reference-path under-floor this task closes). New `resolveMergeBase(base, head)` certifies `merge_base_commit.sha` as 40-hex by construction (throws `TreeParseError` on malformed), maps 404 → `absent`, and propagates non-404s. `base`/`head` inputs are intentionally uncertified: `resolveMergeBase` is a general primitive, and the immutable-head precondition is `forgePolicySource`'s call-site concern (see the Codex BLOCK below).

Exports were threaded through `forge/index.ts` and `index.ts`; tests landed in `policy-source.test.ts` and `github-forge.test.ts`. Clean rebuild is 334/334. No drift into `cli.ts`, `enforcement.ts`, `references/`, or `tier/`; local mode stays byte-identical.

## Scope — claimed and explicitly not claimed

Claims QRM-4.0 prerequisite **[1]** only: it builds the forge-mode policy-provenance capability behind the existing `PolicySource` seam. It does **not** claim [2] (branch-freshness), [3] (trusted/pinned verifier), or [0] (wiring `quorum-verify` / the L2 Gate itself). The CLI stays `--local` and **no forge-mode caller is routed to it** by this task — this is capability, not wiring; wiring is [0] (principle 2: do not claim enforcement not shipped).

**Residual explicitly deferred, not closed here:** the stale-fork / old-permissive-policy case (a PR forked from an old commit whose merge-base carries a laxer policy). `[1]` reads the fork point and preserves merge-base grading by design; dragging the fork forward is prerequisite **[2]**'s (branch-freshness) job. Recorded so the Gate does not imply this is solved.

## First-party confirmations (P1–P5, prototyped against real bytes)

Recorded at length in `docs/handoffs/QRM-4.0-policy-read-design.md` §7.1 on `main` (reference, not duplicated here): `merge_base_commit.sha` returns full 40-hex; forge `getFile` matches local `git show` as oracle (sha256, 72 rules); the encoding guard blocks non-`base64` and closes the `CLAUDE.md` under-floor; base-pinning moves the fork point; the SHA-shape guard holds.

## Review arc

**Design v2 → GPT cross-architect review.** Six amendments, all accepted; two strengthened after byte-verification:

1. SHA-shape certified as full-lowercase 40-hex.
2. Certify `prHeadSha` (the immutable head), not `headRef`.
3. PR-base-mismatch treated as an inherited item-[0] Gate contract (not solved here).
4. Stale-fork / old-policy residual routed to item [2].
5. Encoding fix stays in-task, with a `CLAUDE.md` under-floor test.
6. Symlink wording corrected from "byte-identical" to "behaviorally equivalent."

**The loop:** design v2 → GPT review (6 amendments) → P1–P5 prototype against real bytes (all pass/handled) → Builder (Sonnet) → Architect re-gate → Codex round 1 → fix delta (Builder) → Architect re-gate → Codex focused re-review → PR #21 → squash-merge (manual body) → verified from bytes.

**Codex red-team round 1 — findings and disposition.**

- **BLOCK — `prHeadSha` passed into `resolveMergeBase` uncertified.** The immutable-head precondition was documented but unenforced; tests passing `"HEADSHA"` proved it — a malformed head could reach the network path. The Architect's same-family re-gate missed it; the cross-family reviewer caught it (PMN-001 demonstrated live). **Fix A:** certify `prHeadSha` first, with sentinel tests (call-counters) asserting **zero** network calls on a bad head — genuine regression pins, not incidental passes.
- **CONCERN.** `resolveMergeBase` uncertified `unknown` path. **CONCERN.** Tests weaker than they look. **NIT.** Encoding rows. Fixes B/C/D applied.

**Codex focused re-review.** A/B/C/D all **CONFIRMED CLOSED**. An independent built-bytes probe reproduced `PolicyReadError 0,0` (bad head) and `TreeParseError 1,0` (malformed merge-base).

**Accepted deviation (recorded explicitly).** Fix B makes a malformed *returned* merge-base sha surface as `TreeParseError` (propagated uncaught through `forgePolicySource`), not `PolicyReadError`. Accepted: fail-closed is preserved (both block), and `TreeParseError` is correct-by-layer (a malformed forge response, not a policy problem). `forgePolicySource`'s failure contract is therefore: **it throws to block — `PolicyReadError` or a propagated forge-layer error (e.g. `TreeParseError`) — and never returns a default.** Consequence for the future: **Gate item [0] must be built catch-all** (any throw blocks); no caller may assume `PolicyReadError`-only.

## Residuals tracked (not closed here)

- Stale-fork / old-policy → carried by prerequisite **[2]** (branch-freshness), as noted in Scope.
- Inherited **[0]** base-mismatch contract: the Gate MUST assert `pull_request.base.ref === protectedBranch` and block on mismatch; the PR base is never the policy source. Recorded, implemented at Gate wiring.
- The `certifyCommitSha(mb.value, …)` call in `policy-source.ts` (~line 99) is a **regression backstop** — redundant now that `resolveMergeBase` certifies by construction, and fires only if Fix B regresses. Not dead code; keep.
- **NIT.** Encoding tests assert via an `/encoding/` regex rather than the exact `ContentEncodingError` constructor. Behavior is covered, no hole; optional tighten later.

## Position on the QRM-4.0 board after this task

Prerequisite **[1]** (authenticated base-policy read) satisfied. Board: **[5]** compare parity ✅, **[11]** authenticated listFiles ✅, **[7]/[8]** delegated references ✅ (QRM-3.4), **[1]** ✅ (this task). Remaining before the Gate can be wired: **[2]** branch-freshness (recommended next; also closes the stale-fork residual above) and **[3]** trusted/pinned verifier, then **[0]** wires `quorum-verify` as a required check. `QRM-4.0.json` `state` stays `planned` until [0] ships (per its own item 7). The CLI remains `--local` until [0] routes forge mode into the enforcement path.

---

## Process note — Cowork trial (recorded, not a code finding)

This review record's first draft was produced by a Cowork session as a bounded T0 orchestration trial. The trial was **discontinued**. Two hand-back-fidelity failures were observed, neither dangerous: (1) it authored content beyond the supplied substance, including an unverifiable "Builder: Sonnet, xhigh (reported at hand-back)" — the effort was never confirmed at hand-back; corrected in this record; (2) it handed back a polished artifact while completing far less than the task sheet specified (no manifest read/edit attempt, no staging, no branch), the PMN-002 hand-back-vs-committed-state pattern. Nothing merged, no code was touched, and the only residue was one untracked file in the working tree. Merge authority and the Architect re-gate stayed where they belong. Recorded so the Cowork evaluation outcome is committed history, not chat lore.
