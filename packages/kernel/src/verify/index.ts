import type { Claim, ClaimResult } from "@quorum/contracts";
import type { ForgeAdapter, ForgeResponse } from "../forge/adapter.js";
import type { VerifyContext } from "../types.js";

type Status = ClaimResult["status"];
type Evidence = Record<string, unknown>;
interface Outcome {
  status: Status;
  evidence: Evidence;
}

const verified = (evidence: Evidence = {}): Outcome => ({ status: "verified", evidence });
const failed = (evidence: Evidence = {}): Outcome => ({ status: "failed", evidence });
const disclosed = (evidence: Evidence = {}): Outcome => ({
  status: "unverifiable_disclosed",
  evidence,
});

/**
 * Verify one claim against actual repository/forge state. Pure dispatch over the
 * claim type (SPEC 3.1); all I/O goes through the injected `ForgeAdapter`. The
 * kernel makes zero LLM calls and no network calls outside this adapter.
 */
export async function verifyClaim(
  claim: Claim,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<ClaimResult> {
  const outcome = await dispatch(claim, forge, ctx);
  return {
    claim_id: claim.id,
    type: claim.type,
    status: outcome.status,
    evidence: outcome.evidence,
  };
}

async function dispatch(
  claim: Claim,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  switch (claim.type) {
    case "file_created":
      return checkFileCreated(claim, forge, ctx);
    case "file_modified":
      return checkFileModified(claim, forge, ctx);
    case "file_deleted":
      return checkFileDeleted(claim, forge, ctx);
    case "commit_pushed":
      return checkCommitPushed(claim, forge, ctx);
    case "pr_opened":
      return checkPrOpened(claim, forge, ctx);
    case "issue_filed":
      return checkIssueFiled(claim, forge, ctx);
    case "review_posted":
      return checkReviewPosted(claim, forge);
    case "test_passed":
      return checkTestPassed(claim, forge, ctx);
    default: {
      // Exhaustiveness guard - a new claim type without a checker is a build error.
      const _never: never = claim;
      return _never;
    }
  }
}

// -- file_created ------------------------------------------------------------
async function checkFileCreated(
  claim: Extract<Claim, { type: "file_created" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const file = await forge.getFile(ctx.head, claim.subject.path);
  if (file.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_file" });
  if (file.kind === "absent") return failed({ reason: "file_absent_at_head", path: claim.subject.path });
  return matchExpectedHash(claim, file.value.sha256, { path: claim.subject.path });
}

// -- file_modified -----------------------------------------------------------
async function checkFileModified(
  claim: Extract<Claim, { type: "file_modified" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const head = await forge.getFile(ctx.head, claim.subject.path);
  if (head.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_file" });
  if (head.kind === "absent") return failed({ reason: "file_absent_at_head", path: claim.subject.path });

  const base = await forge.getFile(ctx.mergeBase, claim.subject.path);
  if (base.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_merge_base" });
  const differs = base.kind === "absent" || base.value.sha256 !== head.value.sha256;
  if (!differs) {
    return failed({ reason: "unchanged_from_merge_base", path: claim.subject.path });
  }
  return matchExpectedHash(claim, head.value.sha256, { path: claim.subject.path });
}

// -- file_deleted ------------------------------------------------------------
async function checkFileDeleted(
  claim: Extract<Claim, { type: "file_deleted" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const head = await forge.getFile(ctx.head, claim.subject.path);
  if (head.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_file" });
  if (head.kind === "ok") return failed({ reason: "file_still_present_at_head", path: claim.subject.path });

  const base = await forge.getFile(ctx.mergeBase, claim.subject.path);
  if (base.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_merge_base" });
  if (base.kind === "absent") return failed({ reason: "file_absent_at_merge_base_too", path: claim.subject.path });
  return verified({ path: claim.subject.path, was_present_at: ctx.mergeBase });
}

// -- commit_pushed -----------------------------------------------------------
// `resolveCommit` ok means resolvable AND reachable from head - the adapter,
// which knows head, encapsulates the reachability check (SPEC 3.1).
async function checkCommitPushed(
  claim: Extract<Claim, { type: "commit_pushed" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const res = await forge.resolveCommit(claim.subject.sha);
  if (res.kind === "unsupported") return disclosed({ reason: "forge_cannot_resolve_commit" });
  if (res.kind === "ok") return verified({ sha: res.value.sha });

  // Phantom citation. Record whether the finding's content is nonetheless present
  // (AMAS Sub-shape B: "the citation is phantom, but the finding is still real").
  const evidence: Evidence = { reason: "commit_unresolvable", sha: claim.subject.sha };
  if (claim.expected?.sha256) {
    const matchedPath = await findContentMatch(forge, ctx, claim.expected.sha256);
    if (matchedPath) {
      evidence["content_match"] = true;
      evidence["matched_path"] = matchedPath;
      evidence["note"] = "phantom citation; finding content present at head";
    } else {
      evidence["content_match"] = false;
    }
  }
  return failed(evidence);
}

// -- pr_opened ---------------------------------------------------------------
async function checkPrOpened(
  claim: Extract<Claim, { type: "pr_opened" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const pr = await forge.getPR(claim.subject.number);
  if (pr.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_pr" });
  if (pr.kind === "absent") return failed({ reason: "pr_not_found", number: claim.subject.number });
  if (ctx.branch && pr.value.headRef !== ctx.branch) {
    return failed({
      reason: "pr_head_branch_mismatch",
      claimed_branch: ctx.branch,
      actual_head_ref: pr.value.headRef,
    });
  }
  return verified({ number: pr.value.number, head_ref: pr.value.headRef });
}

// -- issue_filed -------------------------------------------------------------
async function checkIssueFiled(
  claim: Extract<Claim, { type: "issue_filed" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const issue = await forge.getIssue(claim.subject.number);
  if (issue.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_issue" });
  if (issue.kind === "absent") return failed({ reason: "issue_not_found", number: claim.subject.number });
  // SPEC 3.1: issue verified only if authored by the claiming App identity.
  if (ctx.identity && issue.value.author !== ctx.identity) {
    return failed({
      reason: "issue_author_mismatch",
      number: issue.value.number,
      expected_author: ctx.identity,
      actual_author: issue.value.author,
    });
  }
  return verified({ number: issue.value.number, author: issue.value.author });
}

// -- review_posted -----------------------------------------------------------
async function checkReviewPosted(
  claim: Extract<Claim, { type: "review_posted" }>,
  forge: ForgeAdapter,
): Promise<Outcome> {
  const res = await forge.getReviewsAllEndpoints(claim.subject.pr);
  if (res.kind === "unsupported") return disclosed({ reason: "forge_cannot_poll_reviews" });
  if (res.kind === "absent") return failed({ reason: "no_review_endpoints", pr: claim.subject.pr });

  const wanted = claim.subject.surface;
  const items = res.value;
  const match = wanted ? items.find((i) => i.surface === wanted) : items[0];
  // `polled` preserves the full deterministic ordering (incl. same-second
  // tie-break) so the ledger shows nothing was dropped.
  const polled = items.map((i) => ({ id: i.id, surface: i.surface, submitted_at: i.submitted_at }));
  if (!match) {
    return failed({ reason: wanted ? "no_review_on_surface" : "no_reviews", surface: wanted, polled });
  }
  return verified({ matched_id: match.id, surface: match.surface, polled });
}

// -- test_passed -------------------------------------------------------------
async function checkTestPassed(
  claim: Extract<Claim, { type: "test_passed" }>,
  forge: ForgeAdapter,
  ctx: VerifyContext,
): Promise<Outcome> {
  const res = await forge.getCheckRuns(ctx.head);
  if (res.kind === "unsupported") return disclosed({ reason: "forge_cannot_read_checks" });
  if (res.kind === "absent") return failed({ reason: "no_check_runs", check_name: claim.subject.check_name });
  const run = res.value.find((r) => r.name === claim.subject.check_name);
  if (!run) return failed({ reason: "check_not_found", check_name: claim.subject.check_name });
  if (run.conclusion !== "success") {
    return failed({ reason: "check_not_successful", check_name: run.name, conclusion: run.conclusion });
  }
  return verified({ check_name: run.name, conclusion: run.conclusion });
}

// -- helpers -----------------------------------------------------------------
function matchExpectedHash(
  claim: Claim,
  actualSha256: string,
  base: Evidence,
): Outcome {
  const expected = claim.expected?.sha256;
  if (!expected) return verified({ ...base, sha256: actualSha256 });
  if (expected.toLowerCase() === actualSha256.toLowerCase()) {
    return verified({ ...base, sha256: actualSha256 });
  }
  return failed({ ...base, reason: "content_hash_mismatch", expected, actual: actualSha256 });
}

// Boundary (known decision, not a latent surprise): the Sub-shape B content scan
// only considers files CHANGED between mergeBase and head. A phantom-citation
// finding whose content lives in an UNCHANGED file records content_match:false.
// This is intentional per spec intent -- findings concern the change under review,
// not the entire repository tree -- and keeps the scan bounded to the diff.
async function findContentMatch(
  forge: ForgeAdapter,
  ctx: VerifyContext,
  expectedSha256: string,
): Promise<string | null> {
  const cmp = await forge.compare(ctx.mergeBase, ctx.head);
  if (cmp.kind !== "ok") return null;
  const target = expectedSha256.toLowerCase();
  for (const path of cmp.value.changedPaths) {
    const f: ForgeResponse<{ sha256: string }> = await forge.getFile(ctx.head, path);
    if (f.kind === "ok" && f.value.sha256.toLowerCase() === target) return path;
  }
  return null;
}
