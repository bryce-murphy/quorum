import type { Policy, Tier } from "@quorum/contracts";
import { maxTier } from "@quorum/contracts";
import { globMatches } from "./glob.js";

/**
 * Compute the code-enforced tier floor for a diff (SPEC 1.2). For every changed
 * path, every matching rule contributes its floor; the result is the max across
 * all of them (and the policy default if nothing matched). The Gate then takes
 * max(proposed, floor) so a too-low proposed tier cannot lower a risky change.
 */
export function computeTierFloor(diffPaths: readonly string[], policy: Policy): Tier {
  let floor: Tier = policy.default_floor;
  for (const path of diffPaths) {
    for (const rule of policy.rules) {
      if (globMatches(rule.glob, path)) {
        floor = maxTier(floor, rule.floor);
      }
    }
  }
  return floor;
}
