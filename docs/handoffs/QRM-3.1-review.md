# QRM-3.1 — cross-family red-team record

Task: mode-aware tier floor (symlink 120000 / gitlink 160000 changes floor to T3, independent of path globs). Reviewer: Codex (GPT family); Builder/Architect: Claude family. Principle 7 (cross-family review), principle 10 (external evidence). Git-tracked so the evidence is not chat-only (principle 5).

Design was reviewed by the cross-Architect (GPT) before prototyping (PROCEED-TO-PROTOTYPE with four revisions: Gate-must-consume-mode-bearing-diff as a hard requirement; parser fail-closed fatal; keep QRM-3.0 bare-path rules as defense-in-depth; single DiffEntry[] no parallel arrays). Then two adversarial Codex rounds against the implementation.

## Round 1 — verdict BLOCK
- **P1 (fixed): malformed gitlink could spuriously content-cover at T3.** Git plumbing allows committing a mode-160000 entry whose object is a blob, not a commit. getFile() decided eligibility by `cat-file -t` (object type), which returns "blob" for such an entry — so a file_created claim with the blob hash verified and covered the path at T3, defeating the gitlink fail-closed guarantee. Repro: `git update-index --add --cacheinfo "160000,<blobsha>,vendor/bloblink"`. Fix: getFile() decides by TREE MODE via `git ls-tree` (mode 160000 → absent before any content read), regardless of object type. Symlinks (120000) still read their blob.
- **P2 (fixed): GitHubForge.compare under-floored renames.** It synthesized DiffEntry without oldPath and used REST status words, so changedPaths() dropped the rename source — a latent under-floor if a Gate consumed it. Fix: compare() now throws (fail closed); mode-bearing GitHub compare deferred (manifest-required before Gate enforcement). resolveCommit's fallback calls the compare API directly for status only.
- **P3 (fixed): overstated "any deviation throws".** parseRawDiff tolerates a trailing-NUL empty token (a legitimate terminator); doc corrected to "malformed records throw". No real git stream mis-parses.

## Round 2 — verdict CLEAR WITH NOTES
- P1 confirmed resolved (the exact malformed-160000→blob repro now fails closed by tree mode); P2/P3 resolved; no regression on round-1 no-finding axes (real-git parse framing, mode floor on normal symlink/gitlink, symlink blob coverage, local call-site parity).
- One note (fixed): GitHubForge.compare()'s throw propagated through findContentMatch() and crashed the verify path instead of degrading. Fix: findContentMatch wraps compare() in try/catch, returns null (no match) on throw — fail closed, graceful. Regression test added.

## Disposition
Shipped as PR #8 (squash a78e3e5). Deferred, recorded: gitlink_changed claim type (no submodules; submodule changes intentionally unmergeable under strict mode until it exists); GitHubForge mode parity (required before L2 Gate tier-floor enforcement is treated as real); retirement of the now-redundant QRM-3.0 bare-path policy rules (kept as defense-in-depth, retire with a sunset trigger after CI proof).

## Provenance
Re-verified from main after merge: squash a78e3e5, parent e7780a2; `quorum verify --local --task QRM-3.1` reports 17/17 verified at T3 on the branch; declines cleanly on main (empty self-delta).
