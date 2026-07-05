/**
 * String-aware JSONC -> JSON normalization for the opencode extractor.
 *
 * LOAD-BEARING (prototype-proven bypass): a regex comment/trailing-comma stripper
 * is NOT safe here. The substring `/**` + `/` inside a legitimate string literal
 * such as `"guides/**\/*.guide.md"` regex-matches a block comment and is deleted,
 * silently narrowing the recursive glob to `guides*.guide.md` - under-flooring
 * exactly the recursive-glob instruction patterns this extractor exists to catch.
 * Comments and trailing commas are therefore stripped ONLY outside string
 * literals: quoted strings are copied verbatim, honoring backslash escapes.
 *
 * `.jsonc` is floored; `.json` is a subset (no comments/trailing commas) so the
 * same tolerant normalization is safe for both.
 */

/** Strip `//` line comments and block comments that lie OUTSIDE string literals. */
function stripComments(input: string): string {
  let out = "";
  let inStr = false;
  const n = input.length;
  let i = 0;
  while (i < n) {
    const c = input[i]!;
    if (inStr) {
      if (c === "\\" && i + 1 < n) {
        // Escaped char: copy the pair verbatim (an escaped quote does NOT close).
        out += c;
        out += input[i + 1]!;
        i += 2;
        continue;
      }
      out += c;
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      // Line comment: drop to (but keep) the newline so line numbering survives.
      i += 2;
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2; // consume the closing */
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop a `,` that is immediately followed (past whitespace) by `}` or `]`, when
 *  that comma lies OUTSIDE a string literal. */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inStr = false;
  const n = input.length;
  let i = 0;
  while (i < n) {
    const c = input[i]!;
    if (inStr) {
      if (c === "\\" && i + 1 < n) {
        out += c;
        out += input[i + 1]!;
        i += 2;
        continue;
      }
      out += c;
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && (input[j] === " " || input[j] === "\t" || input[j] === "\n" || input[j] === "\r")) {
        j++;
      }
      if (j < n && (input[j] === "}" || input[j] === "]")) {
        i++; // skip the trailing comma
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Normalize JSONC to strict JSON text (string-aware). The result is fed to
 *  `JSON.parse`; a genuine syntax error there is surfaced by the caller as a
 *  fail-closed `unparseable` block. */
export function stripJsonc(input: string): string {
  return stripTrailingCommas(stripComments(input));
}

/** Best-effort human location from a `JSON.parse` failure over `text`. V8 reports
 *  `... at position N`; convert to `line L col C` when present, else `(document)`. */
export function jsonErrorLocation(err: unknown, text: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const posMatch = /position (\d+)/.exec(msg);
  if (!posMatch) return "(document)";
  const pos = Number(posMatch[1]);
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return `line ${line} col ${col}`;
}
