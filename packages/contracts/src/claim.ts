import { z } from "zod";
import { SCHEMA_IDS } from "./ids.js";

/** Claim types and their verification semantics - SPEC 3.1 (Phase 1 set). */
export const CLAIM_TYPES = [
  "file_created",
  "file_modified",
  "file_deleted",
  "commit_pushed",
  "pr_opened",
  "issue_filed",
  "review_posted",
  "test_passed",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const ClaimTypeSchema = z.enum(CLAIM_TYPES);

/** Forge surface a reviewer's output can land on (three-endpoint poll, SPEC 3.1). */
export const REVIEW_SURFACES = ["review", "issue_comment", "line_comment"] as const;
export type ReviewSurface = (typeof REVIEW_SURFACES)[number];
export const ReviewSurfaceSchema = z.enum(REVIEW_SURFACES);

// Author-supplied id; the kernel never mints claims, so the format is validated
// but lenient (ULID-shaped by convention: `clm_<crockford-ish>`).
const ClaimIdSchema = z.string().regex(/^clm_[0-9A-Za-z]{10,40}$/);
const Sha = z.string().regex(/^[0-9a-fA-F]{7,40}$/);
const Sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);
const IssueOrPrNumber = z.number().int().positive();

const PathSubject = z.object({ path: z.string().min(1) }).strict();

// Fields common to every claim. `expected` is a top-level optional (SPEC 3.1
// shows it as a sibling of `subject`) and enables content verification on any
// claim that has a resolvable artifact - notably the Sub-shape B phantom-citation
// case, where the cited action fails but a content-hash match is recorded.
const commonShape = {
  schema: z.literal(SCHEMA_IDS.claim),
  id: ClaimIdSchema,
  task: z.string().min(1),
  agent: z.string().min(1),
  expected: z.object({ sha256: Sha256.optional() }).strict().optional(),
  stated_at: z.string().datetime(),
};

const variant = <T extends ClaimType, S extends z.ZodTypeAny>(type: T, subject: S) =>
  z.object({ ...commonShape, type: z.literal(type), subject }).strict();

export const ClaimSchema = z.discriminatedUnion("type", [
  variant("file_created", PathSubject),
  variant("file_modified", PathSubject),
  variant("file_deleted", PathSubject),
  variant("commit_pushed", z.object({ sha: Sha }).strict()),
  variant("pr_opened", z.object({ number: IssueOrPrNumber }).strict()),
  variant("issue_filed", z.object({ number: IssueOrPrNumber }).strict()),
  variant(
    "review_posted",
    z.object({ pr: IssueOrPrNumber, surface: ReviewSurfaceSchema.optional() }).strict(),
  ),
  variant("test_passed", z.object({ check_name: z.string().min(1) }).strict()),
]);

export type Claim = z.infer<typeof ClaimSchema>;
