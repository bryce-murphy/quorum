// L1 public surface (SPEC 4). Pure deterministic verification - zero LLM calls,
// no network outside the ForgeAdapter.

export { extractClaims } from "./extract/index.js";
export type { ExtractSources, ExtractResult, ExtractError } from "./extract/index.js";

export { verifyClaim } from "./verify/index.js";
export { verifyClaims } from "./run.js";

export { buildLedger, computeVerdict } from "./ledger/build.js";
export { renderLedger, renderHeadline } from "./ledger/render.js";

export { computeTierFloor } from "./tier/floor.js";
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
