import { posix as pathPosix } from "node:path";

/**
 * Shared path primitives for the QRM-3.4 reference extractors. A floored
 * agent-config can steer the agent by REFERENCING an in-repo file by content; if
 * a PR edits only that referenced file it touches a path no static glob floors
 * (default T0). These helpers resolve a reference token to the in-repo path it
 * loads, deterministically from committed bytes, FAIL CLOSED.
 *
 * The claude-md `@import` rule and the opencode `instructions`/`{file:}` rule
 * share the SAME resolution shape (first-party for both): a reference is resolved
 * relative to the CONTAINING config file's directory, filesystem-absolute and
 * `~`-home targets are a hard BLOCK (their repo-relative target is not derivable
 * from committed bytes, and skipping would be fail-open for an absolute path that
 * resolves back inside the checkout), and a relative target that collapses to
 * ESCAPE the repo root is provably outside and skipped.
 */

/** What a raw reference token resolves to before repo-bounds checking. */
export type TokenClass =
  | { readonly kind: "home" }
  | { readonly kind: "absolute" }
  | { readonly kind: "relative"; readonly path: string };

/**
 * Classify a reference token by its LEADING form. `~` (home) and filesystem-
 * absolute (`/abs`, `C:\abs`, UNC `//host`) are not derivable from committed
 * bytes and BLOCK upstream; everything else is repo-relative (backslashes folded
 * to `/` so a Windows-authored `..\sib\x.md` resolves like its POSIX spelling).
 *
 * Do NOT pass the raw token through normalizePath first: it hard-rejects any `..`
 * segment, which would DROP a legitimate in-repo parent reference (`@../sibling`)
 * = the exact bypass this task closes. Classify, collapse, bounds-check, THEN
 * normalize the in-repo remainder.
 */
export function classifyToken(token: string): TokenClass {
  if (token.startsWith("~")) return { kind: "home" };
  // Windows drive-absolute (C:\ or C:/) - detect before folding separators.
  if (/^[A-Za-z]:[\\/]/.test(token)) return { kind: "absolute" };
  const p = token.replace(/\\/g, "/");
  // POSIX-absolute `/x` and UNC `//host/share` both start with `/` after folding.
  if (p.startsWith("/")) return { kind: "absolute" };
  return { kind: "relative", path: p };
}

/** A relative token resolved against a config dir, before the final normalize. */
export type Collapsed =
  | { readonly kind: "escape" }
  | { readonly kind: "inrepo"; readonly path: string };

/**
 * Join a repo-relative reference to its containing config's directory and
 * POSIX-collapse `.`/`..`. A result that still leads with `..` provably escapes
 * the repo root (no in-repo path a PR to this repo can edit) -> ESCAPE (skip, not
 * a bypass). Otherwise the collapsed in-repo path is returned; it may still carry
 * glob metacharacters (opencode instruction globs), so the caller decides whether
 * to run it through normalizePath (exact paths) or keep it as a glob pattern.
 *
 * `dir` is the POSIX dirname of the config path (`.` for a root config). Uses the
 * POSIX path module explicitly so resolution is identical on Windows and Linux.
 */
export function collapseAgainst(dir: string, relPath: string): Collapsed {
  const joined = pathPosix.join(dir === "" ? "." : dir, relPath);
  if (joined === ".." || joined.startsWith("../")) return { kind: "escape" };
  // join() already normalizes; strip a residual leading "./" defensively.
  return { kind: "inrepo", path: joined.replace(/^\.\//, "") };
}

/** POSIX dirname of a (already forward-slashed) repo-relative config path. */
export function configDir(configPath: string): string {
  return pathPosix.dirname(configPath);
}

/** True when a resolved instruction path is a glob pattern (our glob grammar
 *  treats `*`/`**`/`?` as wildcards; `[` is literal). Glob patterns are floored
 *  via the glob set, exact paths via the case-folded exact map. */
export function isGlobPattern(path: string): boolean {
  return /[*?]/.test(path);
}

/** Remote instruction/`{file:}` entries opencode explicitly allows: deterministic-
 *  ally external, not a repo path a PR can edit -> skipped (neither floor nor
 *  block). Only http/https; a local path is never a URL. */
export function isRemoteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// ---------------------------------------------------------------------------
// Fail-closed diagnostics (P3). Every block carries enough to be ACTIONABLE:
// which config, where, which extractor, the offending token, why, and how to fix.
// ---------------------------------------------------------------------------

export type ReferenceBlockReason = "absolute" | "home" | "unparseable" | "unreadable";

export interface ReferenceDiagnostic {
  /** Repo-relative path of the config whose reference blocked. */
  readonly sourceConfig: string;
  /** Where in that config: `line N` (claude-md) or a JSON pointer (opencode). */
  readonly location: string;
  readonly extractor: "claude-md" | "opencode-json";
  /** The offending token verbatim (e.g. `@~/x`, `/abs/x`, `{file:~/x}`). */
  readonly token: string;
  readonly reason: ReferenceBlockReason;
  /** Portable fix (use a repo-relative path). */
  readonly remediation: string;
}

/** Standard remediation for an absolute/home reference. */
export const REPO_RELATIVE_REMEDIATION =
  "use a repo-relative path so the referenced file is resolvable from committed bytes";

/**
 * A fail-closed reference block. Thrown by the extractors/resolver; the CLI's
 * top-level handler surfaces `message` and exits with a protocol (block) code -
 * a floored config whose reference cannot be safely resolved must NEVER silently
 * pass a referenced file at the default tier.
 */
export class ReferenceResolutionError extends Error {
  constructor(readonly diagnostic: ReferenceDiagnostic) {
    super(formatReferenceDiagnostic(diagnostic));
    this.name = "ReferenceResolutionError";
  }
}

export function formatReferenceDiagnostic(d: ReferenceDiagnostic): string {
  return (
    `blocked (fail-closed): ${d.reason} reference in ${d.sourceConfig} ` +
    `at ${d.location} [${d.extractor}] offending token: ${d.token}. ${d.remediation}`
  );
}

/**
 * What one extractor yields for one config file: exact repo-relative paths
 * (normalizePath-canonical, case folded by the resolver) and glob patterns
 * (config-dir-relative). Unioned at the rule's floor into `ReferencedFloors`.
 */
export interface ExtractedReferences {
  readonly exact: readonly string[];
  readonly globs: readonly string[];
}
