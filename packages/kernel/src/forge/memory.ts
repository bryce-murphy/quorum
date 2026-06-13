import { sha256 } from "../hash.js";
import { mergeReviewEndpoints } from "./review-merge.js";
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
  /** ref → (path → content). sha256 is derived, not stored. */
  files?: Record<string, Record<string, string>>;
  /** Shas that are resolvable AND reachable from head. */
  commits?: string[];
  prs?: Record<number, { headRef: string; headSha: string }>;
  issues?: Record<number, { author: string }>;
  reviews?: Record<number, ReviewEndpoints>;
  checks?: Record<string, CheckRun[]>;
  /** "base..head" → compare result (changed paths for Sub-shape B scans). */
  compares?: Record<string, CompareResult>;
  /** Method names this backend should report as `unsupported` (off-ramp sim). */
  unsupported?: string[];
}

/**
 * In-memory `ForgeAdapter` for deterministic fixture replay (the AMAS corpus).
 * Anything not provided resolves to `absent` — i.e. it definitively does not
 * exist — unless the method is listed in `unsupported`.
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

  async resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>> {
    if (this.blocked("resolveCommit")) return unsupported();
    return this.data.commits?.includes(sha) ? ok({ sha }) : absent();
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
