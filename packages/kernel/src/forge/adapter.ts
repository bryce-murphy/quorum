import type { ReviewSurface } from "../types.js";

/**
 * Uniform response envelope for every forge lookup.
 *  - ok         → resolved, value present
 *  - absent     → resolved, the thing definitively does NOT exist (→ `failed`)
 *  - unsupported→ this backend cannot answer (→ `unverifiable_disclosed`)
 *
 * The `unsupported` arm is the off-ramp guarantee made literal (SPEC §4):
 * `LocalGitForge` answers file/commit claims with no forge at all, and honestly
 * reports `unsupported` for PR/issue/review/check claims instead of guessing.
 */
export type ForgeResponse<T> =
  | { kind: "ok"; value: T }
  | { kind: "absent" }
  | { kind: "unsupported" };

export const ok = <T>(value: T): ForgeResponse<T> => ({ kind: "ok", value });
export const absent = <T>(): ForgeResponse<T> => ({ kind: "absent" });
export const unsupported = <T>(): ForgeResponse<T> => ({ kind: "unsupported" });

export interface FileContent {
  readonly content: string;
  readonly sha256: string;
}

export interface CommitInfo {
  readonly sha: string;
}

export interface PrInfo {
  readonly number: number;
  readonly headRef: string;
  readonly headSha: string;
}

export interface IssueInfo {
  readonly number: number;
  readonly author: string;
}

/** One reviewer emission, normalized across the three GitHub surfaces. */
export interface ReviewItem {
  readonly id: string;
  readonly surface: ReviewSurface;
  readonly author: string;
  readonly submitted_at: string;
}

export interface CheckRun {
  readonly name: string;
  readonly conclusion: string;
}

export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface CompareResult {
  readonly status: CompareStatus;
  readonly changedPaths: readonly string[];
}

/**
 * The only surface through which the kernel touches the outside world. Everything
 * else in L1 is pure. Two Phase 1 implementations: `GitHubForge` (REST via
 * App-identity token) and `LocalGitForge` (plain git, offline). Tests drive the
 * verifier through `MemoryForge`.
 */
export interface ForgeAdapter {
  getFile(ref: string, path: string): Promise<ForgeResponse<FileContent>>;
  resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>>;
  getPR(n: number): Promise<ForgeResponse<PrInfo>>;
  getIssue(n: number): Promise<ForgeResponse<IssueInfo>>;
  /** Three-endpoint poll (reviews + issue comments + line comments), merged with
   *  a (submitted_at, id) lexicographic tie-break so same-second emissions survive. */
  getReviewsAllEndpoints(pr: number): Promise<ForgeResponse<readonly ReviewItem[]>>;
  getCheckRuns(sha: string): Promise<ForgeResponse<readonly CheckRun[]>>;
  compare(base: string, head: string): Promise<ForgeResponse<CompareResult>>;
}
