import type { ReviewItem } from "./adapter.js";

/**
 * Merge the three GitHub reviewer surfaces into one deterministically ordered
 * list (SPEC 3.1, "three-endpoint poll"). AMAS evidence: reviewer output lands
 * unpredictably across formal reviews, issue comments, and line comments, and
 * two emissions can share a timestamp to the second.
 *
 * Ordering is lexicographic on (submitted_at, id). The id tie-break is what
 * prevents a same-second emission from being dropped or non-deterministically
 * ordered - every item is preserved, order is stable across machines.
 */
export function mergeReviewEndpoints(
  reviews: readonly ReviewItem[],
  issueComments: readonly ReviewItem[],
  lineComments: readonly ReviewItem[],
): ReviewItem[] {
  return [...reviews, ...issueComments, ...lineComments].sort((a, b) => {
    if (a.submitted_at !== b.submitted_at) {
      return a.submitted_at < b.submitted_at ? -1 : 1;
    }
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}
