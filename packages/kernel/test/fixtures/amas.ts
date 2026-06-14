// The AMAS incident corpus, transcribed into fixtures (SPEC 4; source taxonomy
// in docs/SPEC-HANDOFF.md:25-29). These encode *how* agent claims fail, derived
// from real incidents. Do not weaken a fixture to make a test pass.
import type { Claim } from "@quorum/contracts";
import { ClaimSchema } from "@quorum/contracts";
import { sha256 } from "../../src/hash.js";
import type { MemoryForgeData } from "../../src/forge/memory.js";

let seq = 0;
/** Build a valid claim with sane defaults; throws if the result is malformed. */
export function mkClaim(over: Record<string, unknown>): Claim {
  seq += 1;
  return ClaimSchema.parse({
    schema: "quorum.claim/v1",
    id: `clm_${String(seq).padStart(12, "0")}`,
    task: "QRM-AMAS",
    agent: "builder",
    stated_at: "2026-06-12T03:14:00Z",
    ...over,
  });
}

export const REAL_FINDING = "function add(a, b) { return a + b; }\n";
export const REAL_FINDING_SHA = sha256(REAL_FINDING);

// -- Sub-shape A - fully fabricated claim ------------------------------------
// Cited file does not exist; cited commit SHA does not resolve.
export const subShapeA = {
  forge: { files: { HEAD: {} }, commits: [] } satisfies MemoryForgeData,
  ctx: { head: "HEAD", mergeBase: "BASE" },
  fabricatedFile: mkClaim({ type: "file_created", subject: { path: "src/ghost.ts" } }),
  fabricatedCommit: mkClaim({ type: "commit_pushed", subject: { sha: "deadbeefdeadbeef" } }),
};

// -- Sub-shape B - correct content, fabricated citation ----------------------
// The finding's content is genuinely present at head, but the cited commit SHA
// is phantom. The citation must fail while the content match is recorded.
export const subShapeB = {
  forge: {
    files: { HEAD: { "src/found.ts": REAL_FINDING } },
    commits: [],
    compares: { "BASE..HEAD": { status: "ahead", changedPaths: ["src/found.ts"] } },
  } satisfies MemoryForgeData,
  ctx: { head: "HEAD", mergeBase: "BASE" },
  phantomCitationRealContent: mkClaim({
    type: "commit_pushed",
    subject: { sha: "cafebabecafebabe" },
    expected: { sha256: REAL_FINDING_SHA },
  }),
};

// -- Three-endpoint emission asymmetry (incl. same-second tie-break) ---------
// Reviewer output lands across all three surfaces; two emissions share a
// timestamp to the second and must both survive, deterministically ordered.
export const threeEndpoint = {
  forge: {
    reviews: {
      42: {
        reviews: [
          { id: "b", surface: "review", author: "gpt-codex", submitted_at: "2026-06-12T03:14:00Z" },
        ],
        issueComments: [
          { id: "a", surface: "issue_comment", author: "gpt-codex", submitted_at: "2026-06-12T03:14:00Z" },
        ],
        lineComments: [
          { id: "c", surface: "line_comment", author: "gpt-codex", submitted_at: "2026-06-12T03:14:01Z" },
        ],
      },
    },
  } satisfies MemoryForgeData,
  ctx: { head: "HEAD", mergeBase: "BASE" },
  anySurface: mkClaim({ type: "review_posted", subject: { pr: 42 } }),
  lineCommentSurface: mkClaim({ type: "review_posted", subject: { pr: 42, surface: "line_comment" } }),
};

// -- Post-handback five-point check ------------------------------------------
// When a builder hands back, the receiver re-verifies five things. One forge
// state, one claim per point, each with an expected verdict.
const FIVE_POINT_FILE = "export const ok = true;\n";
export const postHandback = {
  forge: {
    files: { HEAD: { "src/feature.ts": FIVE_POINT_FILE } },
    commits: ["1234567abcdef"],
    reviews: {
      7: {
        reviews: [
          { id: "r1", surface: "review", author: "gpt-codex", submitted_at: "2026-06-12T04:00:00Z" },
        ],
      },
    },
    compares: { "BASE..HEAD": { status: "ahead", changedPaths: ["src/feature.ts"] } },
  } satisfies MemoryForgeData,
  ctx: { head: "HEAD", mergeBase: "BASE", identity: "quorum-gate[bot]" },
  // (1) poll reviewer output
  reviewPoll: mkClaim({ type: "review_posted", subject: { pr: 7 } }),
  // (2) branch tip SHA
  branchTip: mkClaim({ type: "commit_pushed", subject: { sha: "1234567abcdef" } }),
  // (3) file content vs claim - matching hash verifies
  contentMatches: mkClaim({
    type: "file_created",
    subject: { path: "src/feature.ts" },
    expected: { sha256: sha256(FIVE_POINT_FILE) },
  }),
  // (3b) file content vs claim - wrong hash must fail
  contentMismatch: mkClaim({
    type: "file_created",
    subject: { path: "src/feature.ts" },
    expected: { sha256: sha256("DIFFERENT\n") },
  }),
  // (4) phantom-action audit - fabricated file is caught
  phantomAudit: mkClaim({ type: "file_created", subject: { path: "src/nope.ts" } }),
  // (5) comment-content claim on a surface that did not emit must fail
  missingSurface: mkClaim({ type: "review_posted", subject: { pr: 7, surface: "line_comment" } }),
};
