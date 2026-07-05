import type { Policy, Tier } from "@quorum/contracts";
import { maxTier } from "@quorum/contracts";
import type { ForgeAdapter } from "../forge/adapter.js";
import { globMatches, normalizeGlobSeparators, normalizePath } from "../tier/glob.js";
import { EMPTY_REFERENCED_FLOORS, type ReferencedFloors } from "../tier/references.js";
import { extractClaudeMdReferences } from "./claude-md.js";
import { extractOpencodeReferences } from "./opencode.js";
import { ReferenceResolutionError, type ExtractedReferences } from "./path.js";

export { ReferenceResolutionError } from "./path.js";
export type { ReferenceDiagnostic } from "./path.js";

/**
 * Resolve the DELEGATED reference floors for a policy at a trusted ref (QRM-3.4).
 *
 * For every policy rule bearing a `reference_extractor`, enumerate the matching
 * config files at `ref` (`repoReader.listFiles`), read each (`repoReader.getFile`),
 * run the matching extractor, and union the discovered in-repo targets at that
 * rule's floor into a `ReferencedFloors`. The result feeds the PURE floor
 * (`computeTierFloor`) and coverage (`computeUncoveredPaths`).
 *
 * FAIL CLOSED throughout: an extractor that hits an absolute/`~`/unparseable
 * reference throws `ReferenceResolutionError` (the caller blocks); a config that
 * matched a reference-bearing rule but cannot be read, or a tree that cannot be
 * enumerated while reference-bearing rules exist, is likewise a hard block -
 * never a silent lower-tier pass.
 *
 * Async because tree/file reads are async (and the forge counterpart will be
 * network-bound). Callers MUST resolve references at the SAME trusted ref they
 * load the policy from (the canonical fork point), never the PR head.
 */
export async function resolveReferencedFloors(
  policy: Policy,
  repoReader: ForgeAdapter,
  ref: string,
): Promise<ReferencedFloors> {
  const rules = policy.rules.filter((r) => r.reference_extractor !== undefined);
  if (rules.length === 0) return EMPTY_REFERENCED_FLOORS;

  const listing = await repoReader.listFiles(ref);
  if (listing.kind !== "ok") {
    // Reference-bearing rules exist but the tree cannot be enumerated (e.g. a
    // forge backend without tree listing). Fail closed rather than resolve zero
    // references and under-floor.
    throw new ReferenceResolutionError({
      sourceConfig: "(repository tree)",
      location: ref,
      extractor: rules[0]!.reference_extractor!,
      token: "(tree listing)",
      reason: "unreadable",
      remediation: "the forge backend must support tree listing (listFiles) at the trusted ref",
    });
  }
  // Canonicalize once; git tree paths are already clean, but this guarantees the
  // exact-map keys match the normalizePath-canonical changed paths at match time.
  const files = listing.value.map((f) => normalizePath(f));

  const exact = new Map<string, Tier>();
  const globs: { glob: string; floor: Tier; sourceConfig: string }[] = [];

  for (const rule of rules) {
    const extractor = rule.reference_extractor!;
    const glob = normalizeGlobSeparators(rule.glob);
    for (const file of files) {
      if (!globMatches(glob, file)) continue;
      const extracted = await runExtractor(extractor, repoReader, ref, file);
      for (const p of extracted.exact) {
        const key = p.toLowerCase();
        const prev = exact.get(key);
        exact.set(key, prev === undefined ? rule.floor : maxTier(prev, rule.floor));
      }
      for (const g of extracted.globs) {
        globs.push({ glob: g, floor: rule.floor, sourceConfig: file });
      }
    }
  }

  return { exact, globs };
}

async function runExtractor(
  extractor: "claude-md" | "opencode-json",
  repoReader: ForgeAdapter,
  ref: string,
  configPath: string,
): Promise<ExtractedReferences> {
  const res = await repoReader.getFile(ref, configPath);
  if (res.kind !== "ok") {
    // A config the tree listed but we cannot read -> we cannot discover its
    // references. Fail closed (a floored config we can't parse must not pass).
    throw new ReferenceResolutionError({
      sourceConfig: configPath,
      location: "(file)",
      extractor,
      token: "(config content)",
      reason: "unreadable",
      remediation: "ensure the reference-bearing config is a readable text file at the trusted ref",
    });
  }
  if (extractor === "claude-md") {
    return extractClaudeMdReferences(repoReader, ref, configPath, res.value.content);
  }
  return extractOpencodeReferences(configPath, res.value.content);
}
