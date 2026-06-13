import type { Claim } from "@quorum/contracts";

export interface ExtractSources {
  /** Contents of `.quorum/claims/<task>.jsonl` (strict mode primary source). */
  claimsJsonl?: string;
  /** PR body — scanned for a fenced quorum-claims block (strict, secondary) and
   *  for prose action-claims (salvage). */
  prBody?: string;
  /** Commit messages — scanned in salvage mode. */
  commitMessages?: string[];
  /** Task id stamped onto salvaged claims. */
  task?: string;
}

export interface ExtractError {
  source: string;
  line?: number;
  message: string;
}

export interface ExtractResult {
  claims: Claim[];
  /** True in salvage mode: results are advisory and never block (SPEC §3.2). */
  advisory: boolean;
  errors: ExtractError[];
}
