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
import {
  diffTrees,
  parseTreeLeaves,
  TreeParseError,
  type RawTreeResponse,
  type TreeLeaf,
} from "./tree-diff.js";

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

/** A file we cannot certify as readable base64 content (QRM-4.0-policy-read
 *  §4.1) - e.g. the contents API's `encoding:"none"` for blobs > 1MB. Thrown,
 *  never swallowed into `absent`: an unreadable blob is not an absence, and
 *  treating it as one would let a >1MB `CLAUDE.md` silently resolve ZERO
 *  delegated references (`extractClaudeMdReferences("")` -> `[]`, no throw). */
export class ContentEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentEncodingError";
  }
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
    // QRM-4.0-branch-freshness [2], design §3.2/§8 - LOAD-BEARING, do not "fix"
    // away: this is plain `@octokit/rest` with NO retry plugin, NO throttling
    // plugin, and NO request hook. `assertBranchFreshness` reads the merge base
    // FIRST and the protected tip SECOND, and that observed order must never be
    // reversed OR blurred. A per-read auto-retry (e.g. `@octokit/plugin-retry`)
    // could re-issue one read inside that sequence and, on an eventually-consistent
    // replica, serve a stale-but-well-formed tip that spuriously equals the merge
    // base -> a FALSE-FRESH pass, the one outcome freshness must never produce.
    // The no-retry property holds by default today; this comment exists so a future
    // unrelated change (adding a retry plugin for flaky-network reasons) cannot
    // silently remove it. On transient failure: fail closed, or re-run
    // `assertBranchFreshness` WHOLE - never retry a single read in isolation.
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
      if (Array.isArray(data) || data.type !== "file") {
        return absent();
      }
      // QRM-4.0-policy-read §4.1: the contents API returns encoding:"none" (with
      // empty/absent content) for blobs > 1MB. Previously this fell through to
      // `typeof data.content !== "string"` only when content was literally
      // missing - an empty STRING (the common real shape) passed straight to
      // `Buffer.from("", "base64")`, decoding to zero bytes with no error. That
      // was fail-closed only by accident for policy.json (empty -> JSON.parse
      // throws). For a reference-bearing config it is a silent UNDER-FLOOR:
      // `extractClaudeMdReferences("")` returns `[]`, not a throw. Certify the
      // encoding (and that content is actually present) BEFORE decoding, so an
      // unreadable blob is an explicit block, not an accidental one.
      if (data.encoding !== "base64" || typeof data.content !== "string") {
        throw new ContentEncodingError(
          `getFile(${JSON.stringify(path)}) at ${JSON.stringify(ref)}: cannot certify content as base64 ` +
            `(encoding=${JSON.stringify(data.encoding)}) - refusing to treat as absent or decode`,
        );
      }
      // Hash the decoded RAW bytes; expose a UTF-8 view for display only.
      const bytes = Buffer.from(data.content, "base64");
      return ok({ content: bytes.toString("utf8"), sha256: sha256(bytes) });
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  /**
   * Resolve the canonical fork point between `base` and `head` to a commit SHA
   * via the compare API's `merge_base_commit.sha` (QRM-4.0-policy-read [1]) -
   * the forge analog of local's `git merge-base`. Distinct from the public
   * `compare()` above (tree-diff-primary; that surface never reads this
   * field).
   *
   * The returned sha is CERTIFIED (full lowercase 40-hex) before this method
   * hands it back - asserting the real compare-API contract (the field is
   * always a full commit sha), not over-fitting to one caller. A present-but-
   * malformed sha (missing / non-string / short / branch-like / uppercase /
   * wrong-length) is malformed first-party data and throws, same as any other
   * `TreeParseError` vocab check in this file (e.g. `compareStatus` below).
   * This does NOT certify `base`/`head` themselves - they are general refs
   * for a general compare primitive; the immutable-head requirement is
   * `forgePolicySource`'s threat-model-specific concern and is certified
   * there, at that call site, not buried here.
   *
   * A 404 (base or head unresolvable) -> absent; transport errors propagate.
   */
  async resolveMergeBase(base: string, head: string): Promise<ForgeResponse<string>> {
    try {
      const res = await this.api.repos.compareCommitsWithBasehead({
        owner: this.owner,
        repo: this.repo,
        basehead: `${base}...${head}`,
        per_page: 1,
      });
      const data = res.data as { merge_base_commit?: { sha?: unknown } };
      const sha = data.merge_base_commit?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new TreeParseError(
          `compare(${JSON.stringify(base)}...${JSON.stringify(head)}) merge_base_commit.sha is not a full ` +
            `40-hex commit SHA: ${JSON.stringify(sha)}`,
        );
      }
      return ok(sha);
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
  }

  /**
   * Resolve `ref` to its tip COMMIT SHA (QRM-4.0-branch-freshness [2], design
   * §3.1) via `repos.getCommit(ref).data.sha`. The returned sha is CERTIFIED
   * (full lowercase 40-hex) before this method hands it back - the same
   * discipline `resolveMergeBase` applies to `merge_base_commit.sha` - so both
   * sides of a freshness equality are certified symmetrically. A present-but-
   * malformed sha (missing / non-string / short / branch-like / uppercase /
   * wrong-length / non-hex) is malformed first-party data and throws
   * `TreeParseError`. A 404 (ref unresolvable) -> `absent` (absence is never
   * freshness, per adapter.ts:7).
   *
   * NOT built on `resolveTreeSha` (design §3.1): that method is `private` and,
   * critically, its `commitSha` guard is `typeof === "string"` only - shape-
   * checked, NOT 40-hex certified. Reusing it would put an uncertified SHA on
   * one side of an equality whose other side (`resolveMergeBase`) is certified
   * by construction, and asymmetric certification across an equality check is
   * exactly where an under-floor hides. Strengthening `resolveTreeSha` in place
   * would instead change a shipped contract with existing callers (`compare`,
   * `listFiles`). A separate certified resolver keeps both sides symmetric and
   * touches no shipped contract.
   */
  async resolveRefCommit(ref: string): Promise<ForgeResponse<string>> {
    let sha: unknown;
    try {
      const res = await this.api.repos.getCommit({ owner: this.owner, repo: this.repo, ref });
      sha = (res.data as { sha?: unknown }).sha;
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new TreeParseError(
        `resolveRefCommit(${JSON.stringify(ref)}): commit sha is not a full 40-hex commit SHA: ${JSON.stringify(sha)}`,
      );
    }
    return ok(sha);
  }

  async listFiles(ref: string): Promise<ForgeResponse<readonly string[]>> {
    // QRM-4.0 [11]: enumerate tracked leaf paths at `ref` from the SAME recursive-
    // trees surface `compare` uses, so forge-mode delegated-reference resolution
    // (QRM-3.4) fails closed on an unreadable tree rather than resolving zero
    // references. Returns the blob+commit leaf set (tree/directory entries dropped
    // by `parseTreeLeaves`), matching `LocalGitForge.listFiles` (`ls-tree -r`),
    // which lists symlink and gitlink leaves too. Malformed tree data throws
    // (fail closed); an unresolvable ref is `absent`.
    const resolved = await this.resolveTreeSha(ref);
    if (resolved.kind !== "ok") return absent();
    const leaves = await this.fetchTreeLeaves(resolved.value.treeSha);
    if (leaves.kind !== "ok") return absent();
    return ok([...leaves.value.keys()]);
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

  async compare(base: string, head: string): Promise<ForgeResponse<CompareResult>> {
    // QRM-4.0 tree-diff-primary: derive mode-bearing DiffEntry[] from the base and
    // head RECURSIVE git trees, NOT from the compare API's files[] (no modes, ~300
    // cap with no truncation flag). Diff on (sha, mode) per path; renames surface
    // as A+D by construction, which the parity contract permits (§3). The status
    // comes from ONE compare call (per_page=1) whose files[] we ignore entirely.
    //
    // Envelope (§4.6): an unresolvable base or head -> absent (definitively does
    // not exist). Malformed first-party tree data we DID receive (truncated,
    // missing fields, unknown/invalid type-mode, duplicate path) -> throw, via
    // parseTreeLeaves (fail closed: enforcement input we cannot trust). Transport
    // errors propagate. The Gate must treat any non-ok result as blocking.
    //
    // Resolve each ref to a COMMIT SHA once, then pin every read to those SHAs so
    // the (baseTree, headTree, status) triple is bound to two fixed commits by
    // construction. A mutable ref that moves mid-sequence - or a misbehaving API -
    // must not yield a head tree from one commit and a status from another. We do
    // NOT rely on "the Gate passes immutable SHAs" (no forge-mode caller exists
    // yet; that invariant is unenforced): the content-addressed treeSha and the
    // commitSha come from the SAME getCommit response, and compareStatus is called
    // with the resolved commit SHAs, never the caller's raw refs.
    const b = await this.resolveTreeSha(base);
    if (b.kind !== "ok") return absent();
    const h = await this.resolveTreeSha(head);
    if (h.kind !== "ok") return absent();
    const baseLeaves = await this.fetchTreeLeaves(b.value.treeSha);
    if (baseLeaves.kind !== "ok") return absent();
    const headLeaves = await this.fetchTreeLeaves(h.value.treeSha);
    if (headLeaves.kind !== "ok") return absent();
    const changedPaths = diffTrees(baseLeaves.value, headLeaves.value);
    const status = await this.compareStatus(b.value.commitSha, h.value.commitSha);
    if (status.kind !== "ok") return absent();
    return ok({ status: status.value, changedPaths });
  }

  /** Resolve a ref to its commit sha AND tree sha via the Commits API
   *  (`commit.tree.sha`). We do NOT pass a commit sha to the trees endpoint and
   *  rely on its leniency (confirmed present, B1c) - the endpoint is specified
   *  over tree shas, so we resolve explicitly. A 404 (ref/commit absent) -> absent;
   *  a resolvable commit whose response omits sha/tree -> throw (fail closed). */
  private async resolveTreeSha(
    ref: string,
  ): Promise<ForgeResponse<{ commitSha: string; treeSha: string }>> {
    let data: { sha?: string; commit?: { tree?: { sha?: string } } };
    try {
      const res = await this.api.repos.getCommit({ owner: this.owner, repo: this.repo, ref });
      data = res.data;
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
    const commitSha = data.sha;
    const treeSha = data.commit?.tree?.sha;
    if (typeof commitSha !== "string" || typeof treeSha !== "string") {
      throw new TreeParseError(`commit ${JSON.stringify(ref)} response missing sha or commit.tree.sha`);
    }
    return ok({ commitSha, treeSha });
  }

  /** Fetch a recursive tree BY its content-addressed tree sha and reduce it to
   *  the validated leaf map shared by `compare` and `listFiles`. Callers resolve
   *  the ref to a commit+tree sha first (`resolveTreeSha`) and pass `treeSha`
   *  here, so every read is pinned to a fixed commit. A tree that 404s -> absent;
   *  malformed tree data -> throw. */
  private async fetchTreeLeaves(treeSha: string): Promise<ForgeResponse<Map<string, TreeLeaf>>> {
    let data: RawTreeResponse;
    try {
      const res = await this.api.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: treeSha,
        recursive: "1",
      });
      data = res.data;
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
    return ok(parseTreeLeaves(data));
  }

  /** The compare API's top-level `status` (per_page=1 minimizes the commits[]
   *  payload; the response's files[] is ignored entirely). Vocab-checked against
   *  CompareStatus - an unknown value is malformed first-party data and throws
   *  (fail closed). A 404 (base/head unresolvable) -> absent. */
  private async compareStatus(base: string, head: string): Promise<ForgeResponse<CompareStatus>> {
    let raw: string;
    try {
      const res = await this.api.repos.compareCommitsWithBasehead({
        owner: this.owner,
        repo: this.repo,
        basehead: `${base}...${head}`,
        per_page: 1,
      });
      raw = res.data.status;
    } catch (err) {
      if (isNotFound(err)) return absent();
      throw err;
    }
    if (raw === "ahead" || raw === "behind" || raw === "identical" || raw === "diverged") {
      return ok(raw);
    }
    throw new TreeParseError(
      `compare returned unknown status ${JSON.stringify(raw)} (expected ahead|behind|identical|diverged)`,
    );
  }
}
