import type { Policy, Tier } from "@quorum/contracts";
import { maxTier } from "@quorum/contracts";
import { changedPaths, type DiffEntry } from "../diff.js";
import { globMatches, normalizeGlobSeparators, normalizePath } from "./glob.js";

/** Git object modes that are an indirection rather than ordinary file content:
 *  a symlink points elsewhere, a gitlink (submodule) embeds another repo. Either
 *  one, introduced at the NEW side of a change, is floored unconditionally. */
const MODE_SYMLINK = "120000";
const MODE_GITLINK = "160000";

/**
 * Compute the code-enforced tier floor for a diff (SPEC 1.2). Two contributions,
 * combined with the policy default by `max`:
 *
 *  1. PATH GLOBS - for every changed path, every matching rule contributes its
 *     floor. Paths are canonicalized first (see normalizePath) so rules cannot be
 *     evaded by equivalent spellings (backslashes, `./`, doubled slashes). A path
 *     that fails normalization (absolute, traversal, NUL) throws - the floor is a
 *     security control, so a hostile path is a hard error, not a default-floor pass.
 *
 *  2. MODE (QRM-3.1) - any entry whose NEW mode is a symlink (120000) or gitlink
 *     (160000) floors to T3 UNCONDITIONALLY, independent of path-glob matching.
 *     This closes the arbitrary-path symlink/gitlink indirection residual that
 *     path globs structurally cannot catch (QRM-3.0 red-team R2/R3): the dangerous
 *     property is the object's mode, not where it sits in the tree.
 *
 * The Gate then takes max(proposed, floor) so a too-low proposed tier cannot
 * lower a risky change.
 */
export function computeTierFloor(entries: readonly DiffEntry[], policy: Policy): Tier {
  const rules = policy.rules.map((r) => ({ glob: normalizeGlobSeparators(r.glob), floor: r.floor }));
  let floor: Tier = policy.default_floor;
  for (const raw of changedPaths(entries)) {
    const path = normalizePath(raw);
    for (const rule of rules) {
      if (globMatches(rule.glob, path)) {
        floor = maxTier(floor, rule.floor);
      }
    }
  }
  for (const e of entries) {
    if (e.newMode === MODE_SYMLINK || e.newMode === MODE_GITLINK) {
      floor = maxTier(floor, "T3");
    }
  }
  return floor;
}
