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
  /** Ref treated as "head" for commit-membership checks. Defaults to HEAD. */
  head?: string;
  /** Merge-base ref. When set, commit_pushed requires membership in
   *  mergeBase..head (in this branch's delta), not mere reachability (FIX 3). */
  mergeBase?: string;
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
  private readonly mergeBase: string | undefined;

  constructor(opts: LocalGitOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.head = opts.head ?? "HEAD";
    this.mergeBase = opts.mergeBase;
  }

  private isAncestor(commit: string, of: string): boolean {
    return this.git(["merge-base", "--is-ancestor", commit, of]) !== null;
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
    // FIX 2: require an actual blob. A tree (directory) at this path is not file
    // content and must not verify a file claim.
    const objType = this.git(["cat-file", "-t", `${ref}:${path}`]);
    if (objType === null || objType.trim() !== "blob") return absent();
    const bytes = this.gitBytes(["cat-file", "-p", `${ref}:${path}`]);
    if (bytes === null) return absent();
    // Hash the raw bytes; expose a UTF-8 view for display only.
    return ok({ content: bytes.toString("utf8"), sha256: sha256(bytes) });
  }

  async resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>> {
    const exists = this.git(["cat-file", "-e", `${sha}^{commit}`]) !== null;
    if (!exists) return absent();
    // FIX 3: "pushed" means the commit is in THIS branch's delta, not merely
    // reachable from head. Membership in mergeBase..head = reachable from head
    // AND not an ancestor of mergeBase. (An ancestor/base commit fails.)
    if (!this.isAncestor(sha, this.head)) return absent();
    if (this.mergeBase !== undefined && this.isAncestor(sha, this.mergeBase)) {
      return absent();
    }
    return ok({ sha });
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
    // FIX 10: --name-status -M so a rename surfaces BOTH its old and new paths.
    // A file renamed away from schemas/** must still floor T3 and require
    // delete-coverage on the old path; the new path requires create-coverage.
    const out = this.git(["diff", "--name-status", "-M", `${base}..${head}`]);
    if (out === null) return unsupported();
    const changedPaths = parseNameStatus(out);
    return ok({ status: base === head ? "identical" : "ahead", changedPaths });
  }
}

/** Parse `git diff --name-status -M` output into a flat path list. Rename (R)
 *  and copy (C) rows carry old\tnew; both paths are included. */
export function parseNameStatus(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    if ((status.startsWith("R") || status.startsWith("C")) && fields.length >= 3) {
      if (fields[1]) paths.push(fields[1]);
      if (fields[2]) paths.push(fields[2]);
    } else if (fields[1]) {
      paths.push(fields[1]);
    }
  }
  return paths;
}
