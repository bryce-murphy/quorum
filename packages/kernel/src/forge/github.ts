import { Octokit } from "@octokit/rest";
import { sha256 } from "../hash.js";
import { mergeReviewEndpoints } from "./review-merge.js";
import {
  absent,
  ok,
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

export interface GitHubForgeOptions {
  token: string;
  owner: string;
  repo: string;
  /** Head sha/ref used for commit-membership checks. */
  head: string;
  /** Merge-base ref. When set, commit_pushed requires membership in
   *  mergeBase..head (this branch's delta), not mere reachability (FIX 3). */
  mergeBase?: string;
  octokit?: Octokit;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}

/**
 * `ForgeAdapter` over the GitHub REST API, authenticated with a short-lived
 * App-identity token (SPEC 1.1 app-as-identity). 404s map to `absent`; other
 * errors propagate so the Gate can fail closed rather than silently pass.
 */
export class GitHubForge implements ForgeAdapter {
  private readonly api: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly head: string;
  private readonly mergeBase: string | undefined;

  constructor(opts: GitHubForgeOptions) {
    this.api = opts.octokit ?? new Octokit({ auth: opts.token });
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.head = opts.head;
    this.mergeBase = opts.mergeBase;
  }

  async getFile(ref: string, path: string): Promise<ForgeResponse<FileContent>> {
    try {
      const res = await this.api.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
        return absent();
      }
      // Hash the decoded RAW bytes; expose a UTF-8 view for display only.
      const bytes = Buffer.from(data.content, "base64");
      return ok({ content: bytes.toString("utf8"), sha256: sha256(bytes) });
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
    // FIX 3: require membership in this branch's delta (mergeBase..head), not
    // mere reachability - an ancestor/base commit was not "pushed" here.
    if (this.mergeBase !== undefined) {
      try {
        const res = await this.api.repos.compareCommitsWithBasehead({
          owner: this.owner,
          repo: this.repo,
          basehead: `${this.mergeBase}...${this.head}`,
        });
        const deltaShas = res.data.commits.map((c) => c.sha);
        return deltaShas.some((full) => full === sha || full.startsWith(sha))
          ? ok({ sha })
          : absent();
      } catch (err) {
        if (isNotFound(err)) return absent();
        throw err;
      }
    }
    // No merge-base configured: fall back to reachability from head. Call the
    // compare API directly for STATUS only - the public compare() is fail-closed
    // (QRM-3.1 P2) and must not be routed through for tier/coverage.
    try {
      const res = await this.api.repos.compareCommitsWithBasehead({
        owner: this.owner,
        repo: this.repo,
        basehead: `${sha}...${this.head}`,
      });
      const status = res.data.status;
      return status === "ahead" || status === "identical" ? ok({ sha }) : absent();
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
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
      // Paginate ALL THREE surfaces - one default page is not "all endpoints".
      const [reviews, issueComments, lineComments] = await Promise.all([
        this.api.paginate(this.api.pulls.listReviews, {
          owner: this.owner,
          repo: this.repo,
          pull_number: pr,
          per_page: 100,
        }),
        this.api.paginate(this.api.issues.listComments, {
          owner: this.owner,
          repo: this.repo,
          issue_number: pr,
          per_page: 100,
        }),
        this.api.paginate(this.api.pulls.listReviewComments, {
          owner: this.owner,
          repo: this.repo,
          pull_number: pr,
          per_page: 100,
        }),
      ]);
      const reviewItems: ReviewItem[] = reviews
        // A formal review with no submitted_at (e.g. a PENDING review) has not
        // been posted. Drop it - never coerce to "" and let it count as evidence
        // or pollute the (submitted_at, id) tie-break.
        .filter((r): r is typeof r & { submitted_at: string } =>
          typeof r.submitted_at === "string" && r.submitted_at !== "",
        )
        .map((r) => ({
          id: `review:${r.id}`,
          surface: "review" as const,
          author: r.user?.login ?? "",
          submitted_at: r.submitted_at,
        }));
      const issueItems: ReviewItem[] = issueComments.map((c) => ({
        id: `issue_comment:${c.id}`,
        surface: "issue_comment" as const,
        author: c.user?.login ?? "",
        submitted_at: c.created_at,
      }));
      const lineItems: ReviewItem[] = lineComments.map((c) => ({
        id: `line_comment:${c.id}`,
        surface: "line_comment" as const,
        author: c.user?.login ?? "",
        submitted_at: c.created_at,
      }));
      return ok(mergeReviewEndpoints(reviewItems, issueItems, lineItems));
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

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async compare(_base: string, _head: string): Promise<ForgeResponse<CompareResult>> {
    // QRM-3.1 P2: mode-bearing GitHub compare is DEFERRED. The REST compare API
    // returns neither git object modes (symlink 120000 / gitlink 160000) nor a
    // rename's source path in a form this adapter maps faithfully - so building
    // DiffEntry[] here would UNDER-FLOOR any tier/coverage decision that consumed
    // it (modes lost, rename old-paths dropped). Fail closed: throw rather than
    // return silently-wrong entries. The manifest requires real mode-bearing
    // compare before the Gate treats tier-floor enforcement as complete; the CLI
    // is --local only, so nothing currently routes tier decisions through here.
    throw new Error(
      "mode-bearing compare not implemented for GitHubForge (QRM-3.1 deferred; required before Gate enforcement)",
    );
  }
}
