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
          re += "(?:.*/)?"; // `**/` -> zero or more leading directories
        } else {
          re += ".*"; // `**` -> anything incl. slashes
        }
      } else {
        re += "[^/]*"; // `*` -> anything within a path segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}
