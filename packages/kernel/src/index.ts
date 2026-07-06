// L1 public surface (SPEC 4). Pure deterministic verification - zero LLM calls,
// no network outside the ForgeAdapter.

export { extractClaims } from "./extract/index.js";
export type { ExtractSources, ExtractResult, ExtractError } from "./extract/index.js";

export { verifyClaim } from "./verify/index.js";
export { verifyClaims } from "./run.js";

export { buildLedger, computeVerdict } from "./ledger/build.js";
export { applyStrictFailClosed, computeUncoveredPaths } from "./gate.js";
export { renderLedger, renderHeadline } from "./ledger/render.js";

export { computeTierFloor } from "./tier/floor.js";
export { resolveEnforcement } from "./enforcement.js";
export type { PolicySource, EnforcementResult } from "./enforcement.js";
export {
  referencedFloor,
  isReferencedPath,
  EMPTY_REFERENCED_FLOORS,
} from "./tier/references.js";
export type { ReferencedFloors } from "./tier/references.js";
export { resolveReferencedFloors, ReferenceResolutionError } from "./references/resolve.js";
export type { ReferenceDiagnostic } from "./references/resolve.js";
export { extractClaudeMdReferences, parseClaudeImports } from "./references/claude-md.js";
export { extractOpencodeReferences } from "./references/opencode.js";
export { stripJsonc } from "./references/jsonc.js";
export { parseRawDiff, changedPaths, DiffParseError } from "./diff.js";
export type { DiffEntry } from "./diff.js";
export {
  globMatches,
  globToRegExp,
  normalizePath,
  normalizeGlobSeparators,
  PathNormalizationError,
} from "./tier/glob.js";

export { validateArtifact } from "./validate.js";
export type { ValidateResult } from "./validate.js";

export { sha256 } from "./hash.js";

export type { VerifyContext, LedgerContext, ReviewSurface } from "./types.js";

export * from "./forge/index.js";
