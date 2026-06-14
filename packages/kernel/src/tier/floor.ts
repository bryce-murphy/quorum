import type { Policy, Tier } from "@quorum/contracts";
import { maxTier } from "@quorum/contracts";
import { globMatches, normalizeGlobSeparators, normalizePath } from "./glob.js";

/**
 * Compute the code-enforced tier floor for a diff (SPEC 1.2). For every changed
 * path, every matching rule contributes its floor; the result is the max across
 * all of them (and the policy default if nothing matched). The Gate then takes
 * max(proposed, floor) so a too-low proposed tier cannot lower a risky change.
 *
 * Paths are canonicalized first (see normalizePath) so floor rules cannot be
 * evaded by equivalent spellings (backslashes, `./`, doubled slashes). A path
 * that fails normalization (absolute, traversal, NUL) throws - the floor is a
 * security control, so a hostile path is a hard error, not a default-floor pass.
 */
export function computeTierFloor(diffPaths: readonly string[], policy: Policy): Tier {
  const rules = policy.rules.map((r) => ({ glob: normalizeGlobSeparators(r.glob), floor: r.floor }));
  let floor: Tier = policy.default_floor;
  for (const raw of diffPaths) {
    const path = normalizePath(raw);
    for (const rule of rules) {
      if (globMatches(rule.glob, path)) {
        floor = maxTier(floor, rule.floor);
      }
    }
  }
  return floor;
}
