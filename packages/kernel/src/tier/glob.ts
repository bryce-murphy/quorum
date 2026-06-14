/**
 * Minimal, dependency-free glob -> RegExp for policy path rules (SPEC 1.2).
 * Supports the only constructs the floor rules use:
 *   double-star  any run of characters incl. slash (also matches zero leading dirs)
 *   single-star  any run of characters except slash
 *   question     one character except slash
 * Everything else is matched literally. Anchored full-string match.
 *
 * Kept in-house deliberately: pulling a glob library would breach the 7 dep
 * allowlist for a problem this narrow.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // double-star + slash -> zero or more leading dirs
        } else {
          re += ".*"; // double-star -> anything incl. slashes
        }
      } else {
        re += "[^/]*"; // single-star -> anything within a path segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // Case-insensitive: floor rules are a security control, and case-insensitive
  // filesystems (Windows/macOS) make `.GitHub/...` an evasion vector otherwise.
  // Over-matching only raises the floor (fail-closed), which is the safe direction.
  return new RegExp(`^${re}$`, "i");
}

export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/** Raised when a diff path cannot be safely normalized. The tier floor is a
 *  security control, so a malformed/hostile path is a hard error - never a
 *  silent fall-through to the default floor (which would be a floor-evasion). */
export class PathNormalizationError extends Error {}

// NUL byte (0x00) - expressed via char code so this source file stays pure ASCII.
const NUL_BYTE = String.fromCharCode(0);

/**
 * Canonicalize a repository-relative path before glob matching so equivalent
 * spellings cannot evade a floor rule:
 *   - backslashes -> forward slashes (Windows diffs, hostile input)
 *   - collapse repeated slashes
 *   - strip a leading "./"
 * and HARD-REJECT anything that must never appear in a repo-relative diff path:
 * NUL bytes, absolute paths (POSIX `/...`, Windows `C:\...`, UNC `\\...`), and
 * `..` traversal.
 */
export function normalizePath(input: string): string {
  if (input.includes(NUL_BYTE)) {
    throw new PathNormalizationError(`path contains NUL byte: ${JSON.stringify(input)}`);
  }
  // Windows drive-absolute (C:\ or C:/) - check before separator rewrite.
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    throw new PathNormalizationError(`absolute path not allowed: ${input}`);
  }
  const p = input
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "");
  if (p.startsWith("/")) {
    throw new PathNormalizationError(`absolute path not allowed: ${input}`);
  }
  if (p === ".." || p.split("/").includes("..")) {
    throw new PathNormalizationError(`path traversal not allowed: ${input}`);
  }
  return p;
}

/** Normalize separators in a policy glob (trusted input - no traversal checks). */
export function normalizeGlobSeparators(glob: string): string {
  return glob.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}
