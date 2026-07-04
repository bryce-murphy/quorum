# QRM-3.4 — design of record (delegated/transitive agent-config references)

Task: close the delegated/transitive trust surface in the agent-config tier floor. A floored config (T3) can steer the agent by *referencing* arbitrary in-repo files by content; a PR that edits only the referenced file touches a path no static glob floors and computes the default floor (T0). Pre-existing on `main`; surfaced by the Codex QRM-3.3 R2 red-team and adjudicated into this task. Sequenced as a QRM-4.0 Gate prerequisite: a floor that delegation can bypass is a leaky Gate. Principles 12 (fail closed), 2 (don't claim more than shipped), 3 (proportionate ceremony), 5 (git is source of truth). Git-tracked so the design is not chat-only.

## Correction banked at design time (verify-don't-trust in action)

The prior chat-only prototype pinned an import-resolution rule that is **wrong**. It claimed: `@./x` / `@../x` resolve relative to the containing file, but a **bare `@x` resolves repo-root-relative**. Sourced against the first-party doc (https://code.claude.com/docs/en/memory), the actual rule is uniform: *all* relative `@imports` — bare, `./`, and `../` — resolve **relative to the directory of the file containing the import**, never the working directory and never repo-root. Max recursion is **four hops**; import parsing **skips Markdown code spans and fenced code blocks**; backtick-wrapped `` `@x` `` is literal (not imported).

Consequence of the wrong rule: for a bare `@x` inside a *nested* imported file (e.g. `docs/a.md` importing `@b.md`), the handoff rule would floor `b.md` (repo-root) while the real target is `docs/b.md` — the extractor floors the wrong path and misses the real one, i.e. it *reintroduces the exact bypass QRM-3.4 exists to close*. The handoff's "prototype caught a bug (`docs/docs/b.md`, missed depth-2)" was a misread: `docs/a.md` + `@docs/b.md` -> `docs/docs/b.md` is *correct* first-party behavior. The corrected rule was re-prototyped against the real `normalizePath` (8/8; see below). This entry is the load-bearing reason first-party grammar must be sourced before any extractor is written.

## Goal

A changed path that is referenced by a floored reference-bearing config is graded at or above that config's floor, computed deterministically from committed bytes at the trusted ref, fail closed. No over-broad flooring: only actually-referenced paths (or a referenced directory/glob) enter the floor set.

## Design

### A. Resolve references OUTSIDE the pure floor function

`computeTierFloor` stays pure (paths + git modes, never file contents). Reference resolution — which reads config *contents* — happens in the CLI/resolver layer and is passed in.

- `ReferencedFloors = { exact: Map<string, Tier>, globs: { glob: string; floor: Tier; sourceConfig: string }[] }`. Exact keys are `normalizePath`-canonical **and case-folded** (match `globMatches`' case-insensitive, fail-closed posture). A Map alone is insufficient: OpenCode `instructions` accept globs, not just exact paths.
- `computeTierFloor(entries, policy, referencedFloors?)` — optional third arg, backward compatible. After the existing (1) path-glob and (2) git-mode contributions, add (3) exact case-folded lookup of each changed path and (4) glob match via the real `globMatches`. Max-combine as today.

### B. Trusted ref = `canonicalForkPoint(cwd)`, never head

Rides QRM-3.2. Reference directives are read from the merge-base fork point, not the PR head. Reading head would let a PR add/remove a reference to self-grade. Reading base is safe: adding a reference *edits the config*, which is T3-floored on its own.

### C. `reference_extractor` — strict ENUM on policy rules

Schema change in `@quorum/contracts`: an optional `reference_extractor` on a policy rule, `z.enum(["claude-md","opencode-json"]).optional()`. The policy stays the auditable trust surface; an unknown value schema-fails (fail closed). Named `reference_extractor`, not `references` (avoids collision with an OpenCode concept). v1 enum is exactly the two extractors below; Cursor is deferred (§ Deferred).

### D. Resolver + tree discovery (new capability)

`resolveReferencedFloors(policy, repoReader, ref)` walks every rule bearing a `reference_extractor`, finds the matching config files at `ref`, parses them, and produces `ReferencedFloors` at that config's floor. Discovery needs a **tree-listing** capability the `ForgeAdapter` lacks today: `repoReader.listFiles(ref)` — local: `git ls-tree -r --name-only <ref>`. `getFile` alone cannot enumerate all `**/CLAUDE.md`. This adds a **new QRM-4.0 prerequisite: authenticated-forge tree listing** (the forge-mode counterpart, so the Gate can resolve references at the trusted ref).

### E. Extractors

**`claude-md`** — parse `@path` imports from every `**/CLAUDE.md` (and `CLAUDE.local.md`) at the trusted ref.
- Skip Markdown code spans and fenced code blocks; skip backtick-literal `` `@x` `` (first-party: not imported).
- **Resolution (pinned, first-party):** strip the `@` sigil. A **repo-relative** token (bare, `./`, `../`) is joined to the containing file's directory and POSIX-normalized (collapses `..`); if the collapsed result escapes the repo root (leading `..`) it is *provably* outside the repo -> **skip** (no in-repo path a PR to this repo can edit; not a bypass); otherwise pass it through the real `normalizePath` for the final NUL/absolute guard and canonical form. This uniform rule is correct for bare, `./`, and `../`.
- **Absolute and `~`-home imports FAIL CLOSED (P2-1, cross-architect review).** First-party allows absolute/home imports, but their repo-relative target is *not derivable from committed bytes*: the checkout's absolute root is machine-specific in local mode and absent entirely in forge mode. Unconditionally skipping them is fail-**open** — an absolute path that resolves back inside the checkout (a stable CI checkout path, or a repo under `$HOME`) would load a PR-editable repo file the resolver never floors. So a floored config that contains a filesystem-absolute (`@/...`, `@C:\...`) or `~`-home (`@~/...`) import is a **hard error -> verify blocks**, never a silent skip. Remediation is to use a repo-relative import (the portable, gradeable form). Optional local-mode refinement (not required for v1): resolve `~`/absolute against the real `git rev-parse --show-toplevel` and floor the repo-relative remainder when provably inside, still blocking when unprovable — but the uniform block is the conservative baseline and the only coherent forge-mode behavior.
- Do **not** pass the raw token through `normalizePath` first: `normalizePath` hard-rejects any `..` segment, which would drop legitimate in-repo parent references (`@../sibling/x.md` -> `packages/sibling/x.md`) = bypass. Collapse-then-bounds-check, then normalize.
- Recurse referenced `CLAUDE.md`/`.md` imports to a maximum of **four hops** (first-party), matching the set the agent actually loads (no over-broad flooring past hop 4; no under-flooring before it), with cycle detection.

**`opencode-json`** (JSON **and** JSONC — `.jsonc` is floored):
- `instructions: string[]` -> repo-relative plain paths to `exact`, glob patterns to `globs`. **Absolute and `~`-home instruction paths FAIL CLOSED (P1, cross-architect review)** — same shape as the claude-md rule: OpenCode allows absolute/`~` config paths, and one that resolves back into the checkout is a PR-editable repo file the resolver would never floor, so a floored `opencode.json/.jsonc` containing an absolute/`~` instruction path (or `{file:}` path, below) is a **hard error -> verify blocks**, not a silent skip. Skip only a path provably outside the repo.
- `{file:...}` **only in instruction-bearing fields** (`agent.*.prompt`, deprecated `mode.*.prompt`) -> its path to `exact`/`globs`. **Not** arbitrary strings: a provider `apiKey: "{file:~/.secrets/key}"` must not floor.
- **JSONC must be parsed with a STRING-AWARE lexer (prototype finding, load-bearing).** Comment/trailing-comma stripping via regex is a bypass: the substring `/**/` inside a legitimate string literal such as `"guides/**/*.guide.md"` regex-matches a block comment and is deleted, silently narrowing the glob to `guides*.guide.md` and under-flooring exactly the recursive-glob instruction patterns this extractor exists to catch. Strip comments and trailing commas ONLY outside string literals (a proper lexer that copies quoted strings verbatim, honoring escapes). The full re-prototype caught this against a real recursive-glob fixture.
- Unparseable config at the trusted ref -> resolver **throws** -> verify fails closed (block), never silently passes. (Editing the config itself is already T3; the fail-closed case is a PR that edits only a referenced file while the config cannot be parsed to discover it.)
- Git-repo / external-local instruction references deferred.

### F. Integration

Both `cmdVerify` **and** `cmdTier` resolve references by default. Leaving `cmdTier` referenceless would break the QRM-3.2 enforcement-consistency guarantee (`tier` must report what the gate would enforce). The `--policy=head` diagnostic may resolve from head under the existing loud warning.

### G. Coverage sibling-hole override

A referenced path must require coverage even if it matches `exempt_paths` (QRM-3.2 lesson; defense-in-depth — only `.quorum/claims/**` is exempt today). A floored config must not be able to launder a referenced file into an exempt path.

## Deferred / tracked follow-ups (NOT in QRM-3.4 scope)

- **Cursor rule references.** `.cursor/**`, `.cursorrules`, `.cursorignore` are already floored directly (the config/rules files themselves are covered). The open residual is a `.cursor/rules/*.mdc` rule that *references* a non-`.cursor` in-repo file. Deferred until the Cursor `.mdc` reference grammar is first-party-sourced — the QRM-3.4 lesson (the Claude `@import` rule was mis-specified in the handoff) applies: do not implement from memory. Track as a follow-up.
- **`.claude/rules/` symlink targets.** `.claude/rules/*.md` may be symlinks to in-repo files outside `.claude/` (first-party supports this). The symlink itself is already T3 by QRM-3.1 mode floor; editing the symlink's in-repo *target* is the same delegated class as `@import`. Narrow residual; track as a follow-up rather than fold into 3.4.
- **`@/`-leading-slash import semantics.** First-party shows `@~/...` (home) and relative forms but does not document a `@/abs` "absolute from project root" form (third-party sources conflict). v1 fails closed on `@/...` (blocks; see the claude-md resolution rule). If first-party confirms `@/` means repo-root, add a repo-root-relative resolution path in a follow-up rather than blocking.

## Prototype status

The **prior** prototype validated the wrong import rule; its "all axes pass" is not trustworthy on the resolution axis. The **corrected** resolution was re-prototyped against the real `normalizePath` (`packages/kernel/src/tier/glob.ts`), 8/8:

| containing file | import | resolved | note |
| --- | --- | --- | --- |
| `CLAUDE.md` | `@docs/a.md` | `docs/a.md` | root import |
| `docs/a.md` | `@b.md` | `docs/b.md` | BARE in nested file (handoff rule wrongly gave `b.md`) |
| `docs/a.md` | `@./b.md` | `docs/b.md` | dot-slash in nested file |
| `docs/a.md` | `@docs/b.md` | `docs/docs/b.md` | literal `docs/` — correct first-party behavior |
| `packages/a/CLAUDE.md` | `@../b/x.md` | `packages/b/x.md` | in-repo parent ref (blanket `..` reject would DROP = bypass) |
| `CLAUDE.md` | `@../../etc/passwd` | (skip) | escapes repo root via `..` — provably outside |
| `CLAUDE.md` | `@~/.claude/x.md` | (BLOCK) | home — not derivable from bytes, fail closed (P2-1) |
| `CLAUDE.md` | `@/abs/x.md` | (BLOCK) | fs-absolute — not derivable from bytes, fail closed (P2-1) |

Still required before Builder (loop gates unchanged): GPT cross-architect review of this corrected design.

**Full re-prototype DONE (25/25) against the real kernel `dist` at `main` `04c00da`** — `computeTierFloor`, `globMatches`, `normalizePath`, `changedPaths`, `computeUncoveredPaths`, and contracts `maxTier`/`tierRank`, over a purpose-built git fixture (4-hop import chain, cycle, code-fence/inline skips, second nested config, opencode JSONC with recursive glob + agent-prompt `{file:}` + provider `apiKey`, three poisoned branches). All axes pass: full 4-hop chain floors T3 and hop 5 stays T0; cycle terminates; fenced/inline imports skipped; opencode exact + recursive glob + `{file:}` floor T3 while `apiKey {file:~}` is neither floored nor blocked; all three absolute/`~` poisons BLOCK; case-fold exact, mode floor, plain rules, and 2-arg backward-compat intact; coverage override reinstates an `exempt_paths`-exempted referenced path. **New finding folded into the opencode spec above: JSONC must be parsed with a string-aware lexer** — regex comment-stripping corrupts `"guides/**/*.guide.md"` into `guides*.guide.md` (under-flooring bypass), caught only because the fixture used a real recursive-glob instruction.

## Builder routing

Opus 4.8 at xhigh (novel/adversarial T3). Mandatory Codex cross-family red-team on hand-back (hammer the extractors for missed reference forms and resolution edge cases). Advisory per §7 of the handoff.

## Provenance

Design banked pre-Builder; acceptance in `.quorum/manifests/QRM-3.4.json` amended in the same change to scope Cursor out and pin the corrected import rule. Import-resolution rule sourced from https://code.claude.com/docs/en/memory (retrieved 2026-07-03). Corrected resolution re-prototyped against the committed `normalizePath`.
