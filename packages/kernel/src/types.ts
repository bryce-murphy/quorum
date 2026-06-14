import type { Tier } from "@quorum/contracts";

export type { ReviewSurface } from "@quorum/contracts";

/** Repository context a verification run needs that isn't in any single claim. */
export interface VerifyContext {
  /** PR head ref the claims are checked against. */
  readonly head: string;
  /** Merge-base (or base ref) used for modify/delete/Sub-shape-B diff lookups. */
  readonly mergeBase: string;
  /** Branch the task is on (for `pr_opened` head-matches-branch, optional). */
  readonly branch?: string;
  /** The claiming App/bot identity (for `issue_filed` authorship, optional). */
  readonly identity?: string;
}

export interface LedgerContext {
  readonly task: string;
  readonly head: string;
  readonly mode: "strict" | "salvage";
  readonly tier_effective: Tier;
  /** Changed paths not covered by a claim or exemption (FIX 1). */
  readonly uncovered_paths?: readonly string[];
  /** Whether the diff (mergeBase..head) had any changed paths. */
  readonly diff_non_empty?: boolean;
}
