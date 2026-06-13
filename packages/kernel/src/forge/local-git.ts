import { execFileSync } from "node:child_process";
import { sha256 } from "../hash.js";
import {
  absent,
  ok,
  unsupported,
  type CheckRun,
  type CommitInfo,
  type CompareResult,
  type FileContent,
  type ForgeAdapter,
  type ForgeResponse,
  type IssueInfo,
  type PrInfo,
  type ReviewItem,
} from "./adapter.js";

export interface LocalGitOptions {
  /** Repository working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Ref treated as "head" for commit-reachability checks. Defaults to HEAD. */
  head?: string;
}

/**
 * `ForgeAdapter` backed by plain git - the off-ramp guarantee (SPEC 4): the
 * verifier works for file and commit claims with no forge at all. Forge-only
 * claim types (PR / issue / review / check) honestly return `unsupported`, which
 * the ledger records as `unverifiable_disclosed` rather than guessing.
 */
export class LocalGitForge implements ForgeAdapter {
  private readonly cwd: string;
  private readonly head: string;

  constructor(opts: LocalGitOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.head = opts.head ?? "HEAD";
  }

  private git(args: string[]): string | null {
    const buf = this.gitBytes(args);
    return buf === null ? null : buf.toString("utf8");
  }

  /** Run git capturing stdout as raw bytes (no encoding) - required for faithful
   *  content hashing of binary / invalid-UTF-8 blobs. */
  private gitBytes(args: string[]): Buffer | null {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  }

  async getFile(ref: string, path: string): Promise<ForgeResponse<FileContent>> {
    const bytes = this.gitBytes(["cat-file", "-p", `${ref}:${path}`]);
    if (bytes === null) return absent();
    // Hash the raw bytes; expose a UTF-8 view for display only.
    return ok({ content: bytes.toString("utf8"), sha256: sha256(bytes) });
  }

  async resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>> {
    const exists = this.git(["cat-file", "-e", `${sha}^{commit}`]) !== null;
    if (!exists) return absent();
    // Resolvable; require reachability from head (SPEC 3.1).
    const reachable = this.git(["merge-base", "--is-ancestor", sha, this.head]) !== null;
    return reachable ? ok({ sha }) : absent();
  }

  async getPR(): Promise<ForgeResponse<PrInfo>> {
    return unsupported();
  }

  async getIssue(): Promise<ForgeResponse<IssueInfo>> {
    return unsupported();
  }

  async getReviewsAllEndpoints(): Promise<ForgeResponse<readonly ReviewItem[]>> {
    return unsupported();
  }

  async getCheckRuns(): Promise<ForgeResponse<readonly CheckRun[]>> {
    return unsupported();
  }

  async compare(base: string, head: string): Promise<ForgeResponse<CompareResult>> {
    const out = this.git(["diff", "--name-only", `${base}..${head}`]);
    if (out === null) return unsupported();
    const changedPaths = out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
    return ok({ status: base === head ? "identical" : "ahead", changedPaths });
  }
}
