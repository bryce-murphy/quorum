import { sha256 } from "../hash.js";
import { mergeReviewEndpoints } from "./review-merge.js";
import { TreeParseError } from "./tree-diff.js";
import {
  absent,
  ok,
  unsupported,
  type CheckRun,
  type CompareResult,
  type ForgeAdapter,
  type ForgeResponse,
  type CommitInfo,
  type FileContent,
  type IssueInfo,
  type PrInfo,
  type ReviewItem,
} from "./adapter.js";

/** Raw three-endpoint reviewer emissions for a PR (pre-merge). */
export interface ReviewEndpoints {
  reviews?: ReviewItem[];
  issueComments?: ReviewItem[];
  lineComments?: ReviewItem[];
}

export interface MemoryForgeData {
  /** ref -> (path -> content). sha256 is derived, not stored. */
  files?: Record<string, Record<string, string>>;
  /** Shas that are resolvable AND reachable from head. */
  commits?: string[];
  /** ref -> tip commit sha (QRM-4.0-branch-freshness [2]). Feeds resolveRefCommit;
   *  a ref not listed here resolves to `absent`. */
  refs?: Record<string, string>;
  prs?: Record<number, { headRef: string; headSha: string }>;
  issues?: Record<number, { author: string }>;
  reviews?: Record<number, ReviewEndpoints>;
  checks?: Record<string, CheckRun[]>;
  /** "base..head" -> compare result (changed paths for Sub-shape B scans). */
  compares?: Record<string, CompareResult>;
  /** Method names this backend should report as `unsupported` (off-ramp sim). */
  unsupported?: string[];
}

/**
 * In-memory `ForgeAdapter` for deterministic fixture replay (the AMAS corpus).
 * Anything not provided resolves to `absent` - i.e. it definitively does not
 * exist - unless the method is listed in `unsupported`.
 */
export class MemoryForge implements ForgeAdapter {
  constructor(private readonly data: MemoryForgeData = {}) {}

  private blocked(method: string): boolean {
    return this.data.unsupported?.includes(method) ?? false;
  }

  async getFile(ref: string, path: string): Promise<ForgeResponse<FileContent>> {
    if (this.blocked("getFile")) return unsupported();
    const content = this.data.files?.[ref]?.[path];
    if (content === undefined) return absent();
    return ok({ content, sha256: sha256(content) });
  }

  async listFiles(ref: string): Promise<ForgeResponse<readonly string[]>> {
    if (this.blocked("listFiles")) return unsupported();
    const atRef = this.data.files?.[ref];
    if (atRef === undefined) return absent();
    return ok(Object.keys(atRef));
  }

  async resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>> {
    if (this.blocked("resolveCommit")) return unsupported();
    return this.data.commits?.includes(sha) ? ok({ sha }) : absent();
  }

  async resolveRefCommit(ref: string): Promise<ForgeResponse<string>> {
    if (this.blocked("resolveRefCommit")) return unsupported();
    const sha = this.data.refs?.[ref];
    if (sha === undefined) return absent();
    // Certify the fixture sha as full-lowercase-40-hex, exactly as GitHubForge and
    // LocalGitForge do (QRM-4.0-branch-freshness [2], design §3.1). The
    // ForgeAdapter.resolveRefCommit contract promises a CERTIFIED 40-hex identity
    // on both sides of a freshness equality; a MemoryForge fixture returning bytes
    // unchecked made that a false contract - it would seed an uncertified SHA into
    // an equality the fixture corpus is meant to exercise honestly. Malformed
    // first-party data throws the forge-layer error, never `ok`.
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new TreeParseError(
        `resolveRefCommit(${JSON.stringify(ref)}): fixture sha is not a full 40-hex commit SHA: ${JSON.stringify(sha)}`,
      );
    }
    return ok(sha);
  }

  async getPR(n: number): Promise<ForgeResponse<PrInfo>> {
    if (this.blocked("getPR")) return unsupported();
    const pr = this.data.prs?.[n];
    if (!pr) return absent();
    return ok({ number: n, headRef: pr.headRef, headSha: pr.headSha });
  }

  async getIssue(n: number): Promise<ForgeResponse<IssueInfo>> {
    if (this.blocked("getIssue")) return unsupported();
    const issue = this.data.issues?.[n];
    if (!issue) return absent();
    return ok({ number: n, author: issue.author });
  }

  async getReviewsAllEndpoints(pr: number): Promise<ForgeResponse<readonly ReviewItem[]>> {
    if (this.blocked("getReviewsAllEndpoints")) return unsupported();
    const ep = this.data.reviews?.[pr];
    if (!ep) return absent();
    return ok(mergeReviewEndpoints(ep.reviews ?? [], ep.issueComments ?? [], ep.lineComments ?? []));
  }

  async getCheckRuns(sha: string): Promise<ForgeResponse<readonly CheckRun[]>> {
    if (this.blocked("getCheckRuns")) return unsupported();
    const runs = this.data.checks?.[sha];
    if (!runs) return absent();
    return ok(runs);
  }

  async compare(base: string, head: string): Promise<ForgeResponse<CompareResult>> {
    if (this.blocked("compare")) return unsupported();
    const provided = this.data.compares?.[`${base}..${head}`];
    if (provided) return ok(provided);
    return ok({ status: "identical", changedPaths: [] });
  }
}
