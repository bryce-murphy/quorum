import type { ReviewSurface } from "../types.js";
import type { DiffEntry } from "../diff.js";

/**
 * Uniform response envelope for every forge lookup.
 *  - ok         -> resolved, value present
 *  - absent     -> resolved, the thing definitively does NOT exist (-> `failed`)
 *  - unsupported-> this backend cannot answer (-> `unverifiable_disclosed`)
 *
 * The `unsupported` arm is the off-ramp guarantee made literal (SPEC 4):
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
  /** Mode-bearing changed entries (single source). Derive the flat path list
   *  with `changedPaths(entries)`; the tier floor also reads each entry's mode. */
  readonly changedPaths: readonly DiffEntry[];
}

/**
 * The only surface through which the kernel touches the outside world. Everything
 * else in L1 is pure. Two Phase 1 implementations: `GitHubForge` (REST via
 * App-identity token) and `LocalGitForge` (plain git, offline). Tests drive the
 * verifier through `MemoryForge`.
 */
export interface ForgeAdapter {
  getFile(ref: string, path: string): Promise<ForgeResponse<FileContent>>;
  /** List every tracked file path at `ref` (QRM-3.4). Needed to enumerate all
   *  `**` + `/CLAUDE.md` / `opencode.*` configs for delegated-reference
   *  resolution - `getFile` alone cannot discover them. Local: `git ls-tree -r`.
   *  Authenticated-forge tree listing is a QRM-4.0 prerequisite; the GitHub
   *  backend reports `unsupported` (consistent with mode-bearing `compare`). */
  listFiles(ref: string): Promise<ForgeResponse<readonly string[]>>;
  resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>>;
  getPR(n: number): Promise<ForgeResponse<PrInfo>>;
  getIssue(n: number): Promise<ForgeResponse<IssueInfo>>;
  /** Three-endpoint poll (reviews + issue comments + line comments), merged with
   *  a (submitted_at, id) lexicographic tie-break so same-second emissions survive. */
  getReviewsAllEndpoints(pr: number): Promise<ForgeResponse<readonly ReviewItem[]>>;
  getCheckRuns(sha: string): Promise<ForgeResponse<readonly CheckRun[]>>;
  compare(base: string, head: string): Promise<ForgeResponse<CompareResult>>;
  /** Resolve `ref` to its tip COMMIT SHA, CERTIFIED full-lowercase-40-hex by
   *  construction (QRM-4.0-branch-freshness [2], design §3.1) - the same
   *  discipline `GitHubForge.resolveMergeBase` applies to `merge_base_commit.sha`,
   *  so both sides of a freshness equality (`merge_base(protected, head)` vs
   *  `tip(protected)`) are certified symmetrically. A present-but-malformed sha
   *  is malformed first-party data and throws; an unresolvable ref -> `absent`
   *  (absence is never freshness). Distinct from `resolveCommit`, which answers a
   *  commit-membership question against this branch's delta, not "what commit is
   *  at the tip of this ref". */
  resolveRefCommit(ref: string): Promise<ForgeResponse<string>>;
}
