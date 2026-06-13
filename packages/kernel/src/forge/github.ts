import { Octokit } from "@octokit/rest";
import { sha256 } from "../hash.js";
import { mergeReviewEndpoints } from "./review-merge.js";
import {
  absent,
  ok,
  type CheckRun,
  type CommitInfo,
  type CompareResult,
  type CompareStatus,
  type FileContent,
  type ForgeAdapter,
  type ForgeResponse,
  type IssueInfo,
  type PrInfo,
  type ReviewItem,
} from "./adapter.js";

export interface GitHubForgeOptions {
  token: string;
  owner: string;
  repo: string;
  /** Head sha/ref used for commit-reachability checks. */
  head: string;
  octokit?: Octokit;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}

/**
 * `ForgeAdapter` over the GitHub REST API, authenticated with a short-lived
 * App-identity token (SPEC §1.1 app-as-identity). 404s map to `absent`; other
 * errors propagate so the Gate can fail closed rather than silently pass.
 */
export class GitHubForge implements ForgeAdapter {
  private readonly api: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly head: string;

  constructor(opts: GitHubForgeOptions) {
    this.api = opts.octokit ?? new Octokit({ auth: opts.token });
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.head = opts.head;
  }

  async getFile(ref: string, path: string): Promise<ForgeResponse<FileContent>> {
    try {
      const res = await this.api.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
        return absent();
      }
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return ok({ content, sha256: sha256(content) });
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  async resolveCommit(sha: string): Promise<ForgeResponse<CommitInfo>> {
    try {
      await this.api.repos.getCommit({ owner: this.owner, repo: this.repo, ref: sha });
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
    // Resolvable; confirm reachability from head (SPEC §3.1).
    const cmp = await this.compare(sha, this.head);
    if (cmp.kind === "ok" && (cmp.value.status === "ahead" || cmp.value.status === "identical")) {
      return ok({ sha });
    }
    return absent();
  }

  async getPR(n: number): Promise<ForgeResponse<PrInfo>> {
    try {
      const res = await this.api.pulls.get({ owner: this.owner, repo: this.repo, pull_number: n });
      return ok({ number: n, headRef: res.data.head.ref, headSha: res.data.head.sha });
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  async getIssue(n: number): Promise<ForgeResponse<IssueInfo>> {
    try {
      const res = await this.api.issues.get({ owner: this.owner, repo: this.repo, issue_number: n });
      return ok({ number: n, author: res.data.user?.login ?? "" });
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  async getReviewsAllEndpoints(pr: number): Promise<ForgeResponse<readonly ReviewItem[]>> {
    try {
      const [reviews, issueComments, lineComments] = await Promise.all([
        this.api.pulls.listReviews({ owner: this.owner, repo: this.repo, pull_number: pr }),
        this.api.issues.listComments({ owner: this.owner, repo: this.repo, issue_number: pr }),
        this.api.pulls.listReviewComments({ owner: this.owner, repo: this.repo, pull_number: pr }),
      ]);
      const merged = mergeReviewEndpoints(
        reviews.data.map((r) => ({
          id: `review:${r.id}`,
          surface: "review" as const,
          author: r.user?.login ?? "",
          submitted_at: r.submitted_at ?? "",
        })),
        issueComments.data.map((c) => ({
          id: `issue_comment:${c.id}`,
          surface: "issue_comment" as const,
          author: c.user?.login ?? "",
          submitted_at: c.created_at,
        })),
        lineComments.data.map((c) => ({
          id: `line_comment:${c.id}`,
          surface: "line_comment" as const,
          author: c.user?.login ?? "",
          submitted_at: c.created_at,
        })),
      );
      return ok(merged);
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  async getCheckRuns(sha: string): Promise<ForgeResponse<readonly CheckRun[]>> {
    try {
      const res = await this.api.checks.listForRef({ owner: this.owner, repo: this.repo, ref: sha });
      return ok(
        res.data.check_runs.map((r) => ({ name: r.name, conclusion: r.conclusion ?? "" })),
      );
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  async compare(base: string, head: string): Promise<ForgeResponse<CompareResult>> {
    try {
      const res = await this.api.repos.compareCommitsWithBasehead({
        owner: this.owner,
        repo: this.repo,
        basehead: `${base}...${head}`,
      });
      return ok({
        status: res.data.status as CompareStatus,
        changedPaths: (res.data.files ?? []).map((f) => f.filename),
      });
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }
}
