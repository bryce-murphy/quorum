/**
 * Tree-diff-primary derivation (QRM-4.0). GitHub's REST compare `files[]` carries
 * no git object modes and caps at ~300 files with NO truncation flag, so building
 * a `DiffEntry[]` from it would UNDER-FLOOR symlink (120000) / gitlink (160000)
 * changes. Instead we diff the base and head RECURSIVE git trees on `(sha, mode)`
 * per path: the trees API carries `mode`, `type`, `sha`, `path` per entry plus an
 * explicit first-party `truncated` flag - one data surface, one fail-closed
 * signal (confirmed against first-party bytes, B1-B3, 2026-07-06).
 *
 * This module is forge-agnostic and pure: the GitHub adapter feeds it the trees-
 * API response shape; a `git ls-tree -r -t` listing has the identical fields and
 * drives the conformance parity oracle. Nothing here touches the network.
 */
import type { DiffEntry } from "../diff.js";
import { normalizePath } from "../tier/glob.js";

/**
 * A malformed first-party git tree response (QRM-4.0). Thrown - never swallowed -
 * so a tree we cannot fully trust becomes a fatal protocol error (SPEC 4 exit 2),
 * never a silently-partial leaf set that under-floors a tier/coverage decision.
 * Mirrors `DiffParseError` / `PathNormalizationError`: fail closed, a security
 * control does not degrade to a permissive default.
 */
export class TreeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeParseError";
  }
}

/** A leaf we keep from a recursive tree: a blob (regular file, executable, or
 *  symlink) or a commit (gitlink/submodule). `tree` (directory) entries, which a
 *  recursive listing includes, are filtered out - only leaves carry a mode the
 *  floor reads. */
export interface TreeLeaf {
  readonly type: "blob" | "commit";
  readonly mode: string;
  readonly sha: string;
}

/**
 * The loosely-typed shape of a git trees-API response. Declared with every field
 * optional ON PURPOSE: the fail-closed validator MUST re-check fields the Octokit
 * types claim are always present, because a real response (or a test mock) can
 * violate the declared type and we must reject it, not trust the compiler.
 */
export interface RawTreeEntry {
  readonly path?: unknown;
  readonly mode?: unknown;
  readonly type?: unknown;
  readonly sha?: unknown;
}
export interface RawTreeResponse {
  readonly truncated?: unknown;
  readonly tree?: readonly RawTreeEntry[] | unknown;
}

// Accepted (type, mode) pairings, confirmed against first-party GitHub trees-API
// bytes (B1, 2026-07-06, git/git tree): blob -> 100644 | 100755 | 120000; commit
// -> 160000; tree -> 040000 (a directory, filtered from the leaf map). ANY other
// pairing is malformed first-party data and MUST throw: the floor is driven by
// `newMode`, so a bad pairing must never synthesize a plausible entry (a `blob`
// wearing 160000, or a `commit` wearing 100644, would forge or erase a floor).
const BLOB_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);
const COMMIT_MODE = "160000";
const TREE_MODE = "040000";

/**
 * Validate a recursive git trees-API response and reduce it to a leaf map
 * (path -> {type, mode, sha}), fail-closed on anything we cannot fully trust.
 *
 * THROWS `TreeParseError` on: `truncated: true` (the listing is partial - and the
 * SOLE overflow signal, B3, there is no count field to key off); a missing /
 * non-string `path`, `mode`, `type`, or `sha` on any entry; an unknown `type`; an
 * invalid `(type, mode)` pairing; or a duplicate raw path within one response.
 * THROWS `PathNormalizationError` (via `normalizePath`) on a hostile path
 * (absolute / traversal / NUL) so the repo's hard-rejection layer fires at the
 * forge trust boundary, not only downstream in the floor.
 */
export function parseTreeLeaves(res: RawTreeResponse): Map<string, TreeLeaf> {
  if (res.truncated === true) {
    throw new TreeParseError(
      "tree response truncated: the listing is partial and cannot be trusted as complete",
    );
  }
  const entries = res.tree;
  if (!Array.isArray(entries)) {
    throw new TreeParseError("tree response missing the 'tree' array");
  }
  const leaves = new Map<string, TreeLeaf>();
  const seen = new Set<string>();
  for (const e of entries as readonly RawTreeEntry[]) {
    const { path, mode, type, sha } = e;
    if (typeof path !== "string" || path === "") {
      throw new TreeParseError(`tree entry missing a string 'path': ${JSON.stringify(e)}`);
    }
    if (typeof mode !== "string" || typeof type !== "string" || typeof sha !== "string") {
      throw new TreeParseError(`tree entry missing mode/type/sha for path ${JSON.stringify(path)}`);
    }
    // A duplicate RAW path is ambiguous (two (sha, mode) for one path). Reject on
    // the raw path, before any normalization could collapse two spellings into one.
    if (seen.has(path)) {
      throw new TreeParseError(`duplicate path in tree response: ${JSON.stringify(path)}`);
    }
    seen.add(path);
    // Hard-reject a hostile path at the trust boundary (defense in depth: the
    // floor normalizes again downstream, but a forge must not even surface it).
    normalizePath(path);
    if (type === "tree") {
      if (mode !== TREE_MODE) {
        throw new TreeParseError(`invalid (type, mode) pairing: tree with mode ${mode} at ${JSON.stringify(path)}`);
      }
      continue; // directory - not a leaf, carries no mode the floor reads
    }
    if (type === "blob") {
      if (!BLOB_MODES.has(mode)) {
        throw new TreeParseError(`invalid (type, mode) pairing: blob with mode ${mode} at ${JSON.stringify(path)}`);
      }
      leaves.set(path, { type: "blob", mode, sha });
      continue;
    }
    if (type === "commit") {
      if (mode !== COMMIT_MODE) {
        throw new TreeParseError(`invalid (type, mode) pairing: commit with mode ${mode} at ${JSON.stringify(path)}`);
      }
      leaves.set(path, { type: "commit", mode, sha });
      continue;
    }
    throw new TreeParseError(`unknown tree entry type ${JSON.stringify(type)} at ${JSON.stringify(path)}`);
  }
  return leaves;
}

const ZERO_MODE = "000000";

/** The "kind" of a leaf mode for typechange detection: a regular file
 *  (100644/100755), a symlink (120000), or a gitlink (160000). A change that
 *  crosses kinds is a typechange (T); a same-kind mode change (chmod) is M. */
function kindOf(mode: string): "file" | "symlink" | "gitlink" {
  if (mode === "120000") return "symlink";
  if (mode === COMMIT_MODE) return "gitlink";
  return "file"; // 100644 | 100755
}

/**
 * Derive `DiffEntry[]` by diffing two leaf maps on `(sha, mode)` per path. A path
 * present on only one side is A (head-only) or D (base-only); a path on both
 * sides whose sha OR mode differs is a change (status T if it crosses the
 * file/symlink/gitlink kind boundary, else M).
 *
 * Renames are NOT reconstructed: a rename surfaces as A(new) + D(old). The parity
 * contract permits this (§3) - no enforcement consumer reads `DiffEntry.status`
 * or `oldPath`, and the canonical `Map<path,{baseMode,headMode}>` form is
 * identical to a LocalGit `-M` rename entry expanded to its two sides. The status
 * letters exist only to satisfy the `DiffEntry` type; nothing downstream reads
 * them (verified at cd951d9: `computeTierFloor` reads `changedPaths` + `newMode`,
 * `computeUncoveredPaths` a flat path list).
 */
export function diffTrees(
  base: ReadonlyMap<string, TreeLeaf>,
  head: ReadonlyMap<string, TreeLeaf>,
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const [path, b] of base) {
    const h = head.get(path);
    if (h === undefined) {
      entries.push({ status: "D", oldMode: b.mode, newMode: ZERO_MODE, path });
    } else if (h.sha !== b.sha || h.mode !== b.mode) {
      const status = kindOf(b.mode) === kindOf(h.mode) ? "M" : "T";
      entries.push({ status, oldMode: b.mode, newMode: h.mode, path });
    }
    // else: identical sha AND mode -> unchanged, no entry.
  }
  for (const [path, h] of head) {
    if (!base.has(path)) {
      entries.push({ status: "A", oldMode: ZERO_MODE, newMode: h.mode, path });
    }
  }
  return entries;
}
