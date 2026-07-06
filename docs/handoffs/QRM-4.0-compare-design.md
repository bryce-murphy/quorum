# QRM-4.0-compare — GitHubForge.compare parity (design of record, v1)

Status: DESIGN OF RECORD v2 — GPT cross-architect review received 2026-07-05 ("accept with mandatory amendments"); all five amendments adjudicated ACCEPTED by the Architect after independent byte-verification (amendment 2's `loadPolicy` working-tree read confirmed at `cli.ts:141–153`; amendment 1 sharpened: no enforcement path consumes `compare`'s envelope today, so the non-`ok`-blocks rule is NEW contract this task defines for the Gate). GPT's 404 on `docs/reviewers/ARCHITECT-REVIEW.md` is expected — that charter is a banked fast-follow, not yet committed. Nothing implemented; starts clean off `main` at `cd951d9`. Ready for Builder on commit.
Tier proposed: T3 (forge trust boundary; Gate prerequisite [5], carries [11] and item [4]).
Builder: Opus 4.8 at xhigh (novel/adversarial T3 per routing policy). Red-team: Codex (PMN-001, mandatory).

## 1. Problem

`GitHubForge.compare` throws (fail-closed, QRM-3.1 P2) because GitHub's REST compare API returns no git object modes, so any `DiffEntry[]` built from it would UNDER-FLOOR: symlink (120000) and gitlink (160000) floors — the QRM-3.1 guarantee — would silently not hold in forge mode. This is Gate prerequisite [5]; without it no forge-mode tier/coverage decision is permitted, and prerequisites [11] (authenticated `listFiles`) and [4] (Gate consumes a mode-bearing diff) are blocked behind it.

## 2. Grounded findings (all verified against committed bytes or live API)

1. **REST compare `files[]` carries no mode field.** Confirmed live (2026-07-05, unauthenticated, public repo, 26-file range): entry keys are `additions, blob_url, changes, contents_url, deletions, filename, patch, raw_url, sha, status` — no mode-like key on any file. Modes must come from another surface.
2. **No tier/coverage consumer reads `DiffEntry.status`.** From committed bytes at `cd951d9`: `computeTierFloor` reads `changedPaths(entries)` (both rename sides, flat) plus each entry's `newMode`; `computeUncoveredPaths` takes a flat path list. Rename-vs-(add+delete) attribution cannot change any tier or coverage outcome.
3. **The compare API's `files[]` list has a hard cap (~300 files) with NO deterministic truncation flag.** "Fail closed on truncation" would have to be inferred from `files.length` hitting an assumed cap — a hand-maintained assumption of exactly the class that has failed twice (QRM-3.3 dotdirs, QRM-3.4 field allowlist). The trees API, by contrast, carries an explicit first-party `truncated` boolean.
4. **`CompareStatus` (`ahead|behind|identical|diverged`) is exactly the compare API's top-level `status` vocabulary.** Direct first-party mapping, no translation layer.
5. **The trees API is expected to carry `mode` and `type` per entry plus the `truncated` flag** — NOT yet confirmed live (unauthenticated rate limit, twice). **Builder confirmation item B1, under App auth, against first-party response bytes, before implementation.**

## 3. Parity contract (the correctness bar)

> `GitHubForge.compare(base, head)` must yield the same changed-path **SET** (both sides of any rename) and the same per-path git object **MODES** as `LocalGitForge.compare(base, head)`. Rename-vs-(add+delete) attribution need **not** match, and never will by construction (§4). Canonical comparison form: `Map<path, {baseMode, headMode}>` with `000000` for absent-on-that-side; a LocalGit rename entry expands to `oldPath → (oldMode, 000000)` + `path → (000000, newMode)`.

`LocalGitForge.compare` (`git diff --raw -M -z` + `parseRawDiff`) is the parity oracle. By finding 2, set+modes equality under this canonicalization implies identical tier floors and identical coverage decisions across forge modes — the actual guarantee the Gate needs.

## 4. Design: tree-diff-primary

Do **not** build `DiffEntry[]` from the compare API's `files[]` at all. Derive it from the trees:

1. **Resolve commit → tree.** For `base` and `head`, resolve each commit's tree SHA via the Commits API (`commit.tree.sha`). Do not pass a commit SHA to the trees endpoint and rely on leniency — the endpoint is specified over tree SHAs (first-party; Builder confirms exact behavior, B1).
2. **Fetch both trees recursively** (`GET /repos/{o}/{r}/git/trees/{tree_sha}?recursive=1`). **Fail closed** (throw) if: `truncated: true` on either tree; any entry missing `mode`, `type`, `sha`, or `path`; any duplicate raw path within one tree response; or any **invalid `(type, mode)` pairing** (GPT amendment 3 — the floor is driven by `newMode`, so a malformed pairing must never synthesize a plausible entry): `blob` only with `100644 | 100755 | 120000`; `commit` only with `160000`; `tree` only with `040000` and filtered from leaf maps; anything else throws. Keep entries with `type ∈ {blob, commit}` (leaves; `commit` = gitlink; drop `tree` subtree entries, which recursive listings include). B1 records the accepted pair table from first-party bytes.
3. **Diff on `(sha, mode)` per path.** Path in base only → deleted `(oldMode, 000000/D)`; head only → added `(000000, newMode/A)`; both with differing sha or mode → `(oldMode, newMode)`, status `T` if mode changed across the blob/symlink/gitlink kind boundary else `M`. Synthesized entries never carry `oldPath` — renames surface as A+D by construction, which the contract permits and finding 2 makes harmless. Status letters are synthesized only to satisfy the `DiffEntry` type; no enforcement consumer reads them (finding 2).
4. **`CompareResult.status`** from one compare API call with `per_page=1` (top-level `status` field; finding 4). The `files[]` of that response is ignored entirely.
5. **`listFiles(ref)` = the same trees fetch, paths only** — prerequisite [11] rides this task at near-zero marginal cost, replacing the current `unsupported()` and unlocking forge-mode reference resolution (QRM-3.4's floors at the Gate). One shared, cached-per-call tree fetch may serve both `compare` and `listFiles`; caching across calls is out of scope.
6. **`ForgeResponse` envelope semantics (GPT amendment 1 — adjudicated, contradiction removed):** an unresolvable base or head — 404 on the commit, or a commit that resolves but whose tree cannot be fetched because the *ref* does not exist — returns **`absent()`**, matching the adapter vocabulary ("definitively does not exist"). Malformed first-party data we *did* receive — truncated tree, missing fields, unknown or invalidly-paired `type`/`mode`, duplicate paths — **throws** (fail closed: enforcement input we cannot trust). Transport errors propagate. **New consumer contract, defined here:** verified at `cd951d9` that no enforcement path currently consumes `compare`'s envelope (the CLI parses raw git output directly at `cli.ts:296,393`), so this task *defines*, and the conformance suite pins, the rule the Gate ([4]) must follow — **any non-`ok` compare result blocks** before tier/coverage decisions. `absent` is not a pass.

**What this eliminates:** the 300-file cap with no truncation signal (finding 3); GitHub's rename-detector-to-`-M` mapping; the `copied`-status ambiguity (audit F1 — moot: `files[]` is never read for entries); the compare status-vocab translation for files. One fail-closed signal (`truncated`), one data surface, no enumerated status handling.

**Known shared semantics, unchanged:** deletion of a gitlink/symlink does not mode-floor (`newMode` is 000000) — existing adjudicated QRM-3.1 behavior, identical in both modes; parity holds (verified in prototype case C4..C5).

## 5. Prototype (de-risking result — PASSED, 13/13)

Architect prototype (2026-07-05, clean clone at `cd951d9`, real `parseRawDiff` from built kernel `dist/` as the oracle side; `git ls-tree -r -z` listings as the trees-API stand-in — same fields: path, mode, type, sha):

- Synthetic repo exercising every axis in one span: A, M, D, pure rename (R100), edited rename (R<100), mode-only chmod 100644→100755, typechange file→symlink, symlink add, gitlink add / SHA bump / absorption-to-regular-dir, paths with spaces, non-ASCII (including CJK) filenames, empty diff (identical refs) — **all PASS** under the canonical form.
- Real quorum history: six recent first-parent merge spans plus the whole-repo root..HEAD span (20 commits, 114 canonical paths) — **all PASS**.

The tree-diff derivation is byte-equivalent to the oracle on set+modes across every `DiffEntry` status class the kernel parser recognizes. Prototype scripts to be committed with this doc for the record (`docs/handoffs/QRM-4.0-compare-prototype/`).

## 6. Scope addition: extract `resolveEnforcement` into the kernel (audit F5)

`resolveEnforcement` (canonical fork point → policy-at-ref → reference resolution → floor) currently lives in `cli.ts` and constructs `LocalGitForge` internally — the only local coupling. The Gate ([0]/[3]) needs exactly this composition in forge mode; leaving it in the CLI layer means the Gate reimplements it and the two drift, which is how a QRM-3.2/3.4-class fix silently fails to hold at the Gate. **In scope for this task:** move it to the kernel, parameterized over `ForgeAdapter` (+ a ref-provider for the canonical fork point), with `cli.ts` reduced to a thin caller. Behavior byte-identical in local mode (existing 219-test suite must stay green untouched except for import paths).

**Subtlety that must survive the extraction (GPT amendment 2 — verified at `cd951d9`):** the `headDiagnostic` branch reads the **working-tree** `.quorum/policy.json` via `loadPolicy(cwd)` (`existsSync`/`readJson` at `cli.ts:141–153`) while resolving references at `HEAD` — it does NOT read `HEAD:.quorum/policy.json`. A naive refactor through `ForgeAdapter.getFile("HEAD", …)` silently changes dirty-working-tree diagnostic behavior. Required shape: an explicit **`PolicySource`** seam — enforcement = `policyAtRef(canonicalForkPoint)` with references at the same ref; diagnostic = `policyFromWorkingTree()` with references at `HEAD`; forge mode exposes **no** working-tree diagnostic. **Required regression test:** working-tree `.quorum/policy.json` differing from `HEAD`'s, asserting `tier --policy=head` output semantics are unchanged.

## 7. Conformance suite (audit F6 — the correctness bar as executable bytes)

A **parameterized ForgeAdapter parity suite**, not a one-off test: given any two adapters and a (base, head) pair, assert canonical-form equality (§3). Runs as:
- LocalGitForge vs the tree-diff derivation over a committed synthetic fixture repo covering every §5 axis (ported from the prototype), exercised hermetically (the GitHub side's tree-listing consumption tested against recorded/mocked trees-API response shapes captured under B1);
- LocalGitForge self-consistency over real quorum history spans (cheap regression);
- one live authenticated GitHubForge-vs-LocalGitForge run against real quorum commits, executed during the Builder/red-team/re-gate phases and recorded in the handoff doc (not in CI until the Gate's own auth lands);
- **malformed tree-response fixtures, each asserting fail-closed** (GPT amendment 4): `truncated: true`; missing `path`/`mode`/`type`/`sha`; unknown `type`; unknown `mode`; invalid `(type, mode)` pair (e.g. `blob`+`160000`, `commit`+`100644`); duplicate raw path in one response; and a path that `normalizePath` rejects (absolute, traversal, NUL) — the repo's existing hard-rejection layer must fire through the forge path too;
- **`listFiles` parity, acceptance-level, separate from compare parity** (GPT amendment 5): `GitHubForge.listFiles(ref)` yields the same leaf-path set as `LocalGitForge.listFiles(ref)` over the synthetic fixture, including symlink and gitlink leaf paths — this is what makes QRM-3.4's `resolveReferencedFloors` fail-closed contract actually hold in forge mode rather than merely stop failing.
A future forge adapter inherits this oracle for free.

## 8. Builder confirmation items (first-party, under App auth, BEFORE implementation)

- **B1:** trees API response — confirm `mode`, `type`, `sha`, `path`, `truncated` fields live against real response bytes; confirm commit-SHA-vs-tree-SHA endpoint behavior; record accepted `mode` value set (100644, 100755, 120000, 160000, 040000) and that recursive listings include `tree` entries to be filtered.
- **B2:** compare API top-level `status` values against `CompareStatus` vocab with `per_page=1`.
- **B3:** trees API size limits (documented ~100k entries / 7 MB) and that `truncated` is the sole overflow signal.
Pinned-constant rule applies: none of these are implemented from memory; the handoff records the confirming bytes.

## 9. Residuals and carried amendments (tracked, not closed here)

- **R1 (audit F3, fail-safe direction):** `resolveCommit`'s delta-membership check reads a single unpaginated page of compare `commits[]`; a >250-commit branch can misread a pushed commit as `absent` — blocks, never under-floors. Track on this task's manifest as a recorded residual; fix rides any later touch of that path.
- **R2 (carried manifest amendment, ratified 2026-07-05):** QRM-4.0 item [3] gains the clause: *"…and no PR-influenced state (caches, artifacts, restored dependencies) enters the verifier's execution context (cache poisoning across the fork↔base trust boundary is PR influence without running PR-head code); verifier workflow actions pinned to SHAs; `pull_request`, never `pull_request_target`."* Rides this task's T0 bookkeeping PR.
- **R3:** cross-family judge literature (2025–26) documents family bias empirically and shows even cross-family panels retain heavily correlated errors (~9 judges ≈ 2 independent votes). Recorded as calibration: Codex + GPT + third-family audit passes are correlation *reduction*, never independence; only the deterministic layer floors. No process change.

## 10. Acceptance (draft, for the task manifest)

1. `GitHubForge.compare` returns mode-bearing `DiffEntry[]` derived from base+head recursive trees (never from compare `files[]`), satisfying the §3 parity contract; the fail-closed throw is removed only by this implementation.
2. Envelope semantics per §4.6: `absent()` when base or head cannot be resolved to a commit/tree; **throw** on malformed first-party tree data (truncated, missing required fields, unknown modes/types, invalid `(type, mode)` pairings, duplicate paths). The Gate must treat any non-`ok` compare result as blocking before tier/coverage decisions; the conformance suite pins this. No silent partial diffs, ever.
3. `CompareResult.status` sourced from the compare API top-level `status` (`per_page=1`), vocab-checked (B2).
4. `GitHubForge.listFiles` implemented from the same trees surface (prerequisite [11]); `unsupported()` removed; forge-mode reference resolution becomes possible (not wired to the CLI in this task — CLI stays `--local`).
5. `resolveEnforcement` extracted to the kernel behind an explicit `PolicySource` seam (§6): enforcement reads policy at the canonical fork point; the `--policy=head` diagnostic keeps its working-tree-policy + references-at-HEAD semantics, protected by a regression test with working-tree policy differing from `HEAD`; forge mode exposes no working-tree diagnostic; local-mode behavior byte-identical; existing suite green.
6. Conformance suite (§7) committed: compare parity, **`listFiles` parity**, and **malformed tree-response fail-closed fixtures** (including the `normalizePath`-rejection case), over the synthetic fixture repo covering every §5 axis; one recorded live parity run against real quorum commits in the handoff.
7. B1–B3 confirmations recorded in the handoff with first-party response evidence before any implementation commit.
8. Marks QRM-4.0 prerequisites [5] and [11] satisfied and unblocks [4]; does NOT claim [1] (base-policy read wiring), [2], [3], or the Gate itself.

## 11. Loop

This doc → GPT cross-architect review → adjudicate → commit design + manifest (T0-floored docs; branch cut from `cd951d9`) → Builder (Opus 4.8 xhigh; holds branch, never pushes; hand-back reports actual model+effort) → Architect byte-level re-gate from committed diff → Codex red-team (trust-boundary, mandatory; probe especially: truncation fail-closed paths, type-filter completeness, commit→tree resolution, hostile path handling through `normalizePath`) → push → independent clean-clone verify (clean `dist/`, full suite, live parity run) → PR → Owner squash-merge, manual body → T0 bookkeeping (manifest state, handoff review doc, R2 amendment).
