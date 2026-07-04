import type { Tier } from "@quorum/contracts";
import { maxTier } from "@quorum/contracts";
import { globMatches } from "./glob.js";

/**
 * The referenced-floor set produced by `resolveReferencedFloors` (QRM-3.4) and
 * consumed by the PURE floor/coverage layer. Kept dependency-free (no forge, no
 * extractors) so `computeTierFloor` and `computeUncoveredPaths` can import the
 * matcher without pulling in tree-reading.
 *
 *  - `exact`: `normalizePath`-canonical, LOWER-CASED path -> floor. Case folding
 *    matches `globMatches`' case-insensitivity (a case-varying filesystem must
 *    not evade a referenced floor).
 *  - `globs`: opencode `instructions` may be glob patterns, not just exact paths.
 */
export interface ReferencedFloors {
  readonly exact: ReadonlyMap<string, Tier>;
  readonly globs: readonly { readonly glob: string; readonly floor: Tier; readonly sourceConfig: string }[];
}

/** An empty referenced-floor set - the backward-compatible default (no
 *  references resolved => identical behavior to pre-QRM-3.4). */
export const EMPTY_REFERENCED_FLOORS: ReferencedFloors = { exact: new Map(), globs: [] };

/**
 * The referenced floor for a changed path: the max over an exact case-folded
 * lookup and every matching glob, or `undefined` if the path is not referenced.
 *
 * This is the SINGLE definition of the exact/case-fold/glob matching semantics
 * (P2). `computeTierFloor` uses the returned tier; `computeUncoveredPaths` uses
 * `isReferencedPath` (a thin boolean wrapper) - so the two enforcement points
 * cannot drift onto divergent hand-written matchers. `path` must already be
 * `normalizePath`-canonical (both call sites normalize first).
 */
export function referencedFloor(path: string, refs: ReferencedFloors): Tier | undefined {
  let floor: Tier | undefined = refs.exact.get(path.toLowerCase());
  for (const g of refs.globs) {
    if (globMatches(g.glob, path)) floor = floor === undefined ? g.floor : maxTier(floor, g.floor);
  }
  return floor;
}

/** Whether a changed path is referenced by any floored config (exact case-fold OR
 *  glob). Wraps `referencedFloor` so coverage and floor share one matcher (P2). */
export function isReferencedPath(path: string, refs: ReferencedFloors): boolean {
  return referencedFloor(path, refs) !== undefined;
}
