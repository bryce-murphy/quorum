# QRM-4.0-compare — Builder hand-back (Opus 4.8, xhigh)

Builder: Claude Opus 4.8, effort xhigh. Branch `qrm-4.0-compare-parity`, held (NOT pushed). Implements design of record v2 (`QRM-4.0-compare-design.md`) + manifest `.quorum/manifests/QRM-4.0-compare.json`. Satisfies prerequisites **[5]** and **[11]**, unblocks **[4]**; claims nothing else.

## Phase 1 — B1–B3 first-party confirmation (BEFORE any implementation)

Confirmed against **real first-party GitHub REST bytes** on 2026-07-06 via the authenticated `gh` user-to-server token (`gho_…`, scope `repo`). Auth-type note: this is a user token, not an App installation token; the two are **byte-identical in JSON shape** for the trees/commits/compare endpoints (auth type changes rate limits and repo scope, not response schema). Nothing implemented from memory. No B-item diverged from the design's assumptions.

### B1 — trees API + commit→tree resolution
- `GET /repos/{o}/{r}/git/trees/{tree_sha}?recursive=1` top-level keys: **`sha`, `tree`, `truncated`, `url`**. `truncated` is a **boolean**, present on every response.
- Per-entry keys: **`path`, `mode`, `type`, `sha`** (+ `size` on blobs; **absent on `commit`/gitlink entries** — so we require only path/mode/type/sha, never size).
- Accepted `(type, mode)` pairs, from live `git/git` tree bytes (a repo containing all kinds; quorum's own tree only has `blob 100644` + `tree 040000`):
  - `blob` → `100644` | `100755` | `120000`
  - `commit` → `160000` (gitlink; concrete entry: `{mode:"160000", type:"commit", path:"sha1collisiondetection"}`)
  - `tree` → `040000` (directory — filtered from the leaf map)
  - No cross-pairings observed. Any other pairing is treated as malformed → throw.
  - Concrete symlink entry: `{mode:"120000", type:"blob", size:34, path:"RelNotes"}`.
- **Commit→tree resolution:** `GET /repos/{o}/{r}/commits/{ref}` returns `.sha` (resolved commit) and `.commit.tree.sha` (tree). Confirmed live for `cd951d9` → tree `3d9cd1fd…`.
- **B1c leniency (recorded, NOT relied upon):** the trees endpoint *does* accept a commit SHA and return its tree (echoing the commit SHA back as `.sha`). The design deliberately resolves commit→tree via the Commits API first rather than depend on this. Implementation follows the design.

### B2 — compare top-level status
- `GET /repos/{o}/{r}/compare/{base}...{head}?per_page=1` top-level `.status` observed live: **`ahead`**, **`identical`**, **`behind`**. The 4th value **`diverged`** is the documented value for a two-sided divergence (not reproducible on quorum's linear pushed `main`); `CompareStatus` already enumerates exactly these four.
- **Sub-finding:** `per_page=1` bounds `commits[]`, **not** `files[]` (a 1-commit/2-file range still returned 2 files). Irrelevant here — the implementation ignores `files[]` entirely and reads only `.status`.

### B3 — size limits / truncation is the sole overflow signal
- Forced `truncated:true` live against `torvalds/linux` (recursive): returned **71 797** partial entries, top-level keys still exactly `["sha","tree","truncated","url"]`, and **no `count`/`total`/overflow field**. So `truncated` is the **sole** overflow signal — there is nothing else to key off. Documented limit ≈ 100k entries / 7 MB. Implementation throws on `truncated:true` (fail closed).

## Phase 2 — implementation (committed on the branch)

- **`packages/kernel/src/forge/tree-diff.ts`** (new): pure, forge-agnostic. `parseTreeLeaves` validates a trees response fail-closed (throws `TreeParseError` on truncated / missing path·mode·type·sha / unknown type / invalid `(type,mode)` pair / duplicate raw path; throws `PathNormalizationError` via `normalizePath` on a hostile path — the hard-rejection layer fires at the forge boundary). `diffTrees` diffs two leaf maps on `(sha, mode)` per path; renames surface as A+D by construction.
- **`packages/kernel/src/forge/github.ts`**: `compare` is now tree-diff-primary (base+head recursive trees, status from one `per_page=1` compare call, `files[]` ignored); `listFiles` implemented from the same trees surface (`unsupported()` removed). Envelope: unresolvable base/head → `absent`; malformed tree data → throw; transport errors propagate.
- **`packages/kernel/src/enforcement.ts`** (new): `resolveEnforcement(source: PolicySource, repoReader: ForgeAdapter, diffEntries)` — the enforcement composition, extracted from `cli.ts`, parameterized over `ForgeAdapter`. The `PolicySource` seam keeps the working-tree-vs-ref **provenance** decision with the caller.
- **`packages/kernel/src/cli.ts`**: reduced to a thin caller that builds the `PolicySource`. The `--policy=head` diagnostic still reads the **working-tree** `.quorum/policy.json` via `loadPolicy(cwd)` (existsSync/readJson) with references at HEAD — NOT `HEAD:.quorum/policy.json`. Local-mode behavior byte-identical. **CLI remains `--local` only** (not wired to forge mode).
- Barrels updated (`forge/index.ts`, `index.ts`).

## Conformance suite — `packages/kernel/test/forge-parity.test.ts` (new, 50 tests)

Parameterized ForgeAdapter parity oracle over a committed synthetic fixture repo built via git plumbing (`update-index --cacheinfo`, portable on Windows) covering every design §5 axis: A / M / D / pure-rename R100 / edited-rename R<100 / mode-only chmod / typechange file→symlink / symlink add / symlink retarget / gitlink add·sha-bump·absorb-to-regular-dir / spaces / CJK / unchanged / empty-diff.
- **(a) compare parity** — canonical `Map<path,{base,head}>` equality between `GitHubForge` (git-backed trees-API stand-in) and `LocalGitForge`, plus non-vacuous mode assertions (symlink 120000, gitlink 160000, chmod 644→755, typechange, gitlink-delete newMode 000000).
- **(b) listFiles parity** — identical leaf set at base and head, incl. symlink + gitlink leaves.
- **(c) malformed-tree fail-closed** — 15 cases (truncated, each missing field, unknown type, unknown mode, three invalid pairs, duplicate path, missing tree array, and normalizePath-rejected `..`/absolute/NUL), each asserted through BOTH `parseTreeLeaves` AND the `GitHubForge.compare`/`listFiles` forge path.

Plus the `--policy=head` dirty-working-tree regression in `policy-from-base.test.ts` (working-tree policy T3 vs HEAD-committed T1 → asserts T3, i.e. the working tree is read, not `HEAD:`).

## Verification results

- **Full suite from clean `dist/` rebuild:** `276 passed (25 files)` — up from the 219/24 baseline (+57 new: 50 conformance, +5 github-forge wiring, +2 dirty-tree regression). The existing 219 stayed green (only import-path churn in `cli.ts`).
- **Live authenticated parity run** (GitHubForge real REST API vs LocalGitForge over real pushed quorum commits):
  - `3492100..cd951d9`: status ahead, 2 paths — compare set+modes **PARITY**, listFiles(121) **PARITY**
  - `06a165b..cd951d9`: status ahead, 26 paths — compare **PARITY**, listFiles(121) **PARITY**
  - `7ebb789..3492100`: status ahead, 25 paths — compare **PARITY**, listFiles(120) **PARITY**

## Deviations from the design

None material. Two recorded choices, both within the design's latitude:
1. **`normalizePath` gate stores raw paths.** `parseTreeLeaves` calls `normalizePath(path)` as a fail-closed gate (throws on hostile) but stores the RAW path in the leaf/`DiffEntry` — matching `LocalGitForge`'s "store what git emitted" semantics exactly (`normalizePath` is identity on all legitimate git paths, so parity is unaffected; hostile paths throw at the boundary as the design requires).
2. **Compare-status vocab check throws a `TreeParseError`.** An unknown `.status` is malformed first-party data; it reuses the tree fail-closed error class rather than introducing a second one. Both fail closed (exit 2) identically.

## Residuals (unchanged / tracked, NOT fixed here)

- **R1 (manifest item 8):** `resolveCommit`'s delta-membership check still reads one unpaginated page of compare `commits[]`; a >250-commit branch can misread a pushed commit as `absent` (blocks, never under-floors). Untouched — fix rides a later touch of that path.
- Gitlink/symlink **deletion** does not mode-floor (newMode 000000) — verified for parity (fixture `sub-absorb`: `{base:160000, head:000000}`).
