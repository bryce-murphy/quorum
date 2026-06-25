/**
 * Mode-bearing diff model - the single source for "what changed" across the
 * kernel. The verifier reads `git diff --raw -M -z` (not `--name-status`) so the
 * tier floor can react to the git object *mode*, not just the path string: a
 * symlink (120000) or gitlink/submodule (160000) is an indirection that a path
 * glob cannot reliably catch (QRM-3.0 red-team R2/R3). Parsing lives here,
 * `CompareResult` carries `DiffEntry[]`, and `changedPaths` is the ONE
 * derivation of the flat path list - replacing the old `parseNameStatus` string
 * channel everywhere it was used.
 */

/** One changed entry from `git diff --raw -M -z`. */
export interface DiffEntry {
  /** Raw git status: `A`/`M`/`D`/`T`, or `R<score>`/`C<score>` for rename/copy. */
  readonly status: string;
  /** Old git object mode (6 octal digits); `000000` for an added path. */
  readonly oldMode: string;
  /** New git object mode (6 octal digits); `000000` for a deleted path. */
  readonly newMode: string;
  /** The (new) path. For a rename/copy this is the destination path. */
  readonly path: string;
  /** Source path - present ONLY for rename/copy (status `R*`/`C*`). */
  readonly oldPath?: string;
}

/**
 * A malformed `--raw -z` stream. Thrown - never swallowed - so a bad diff is a
 * fatal protocol error with a non-zero exit, not a silently-partial entry list.
 * The floor is a security control; fail closed (SPEC 4 exit code 2).
 */
export class DiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

const NUL = String.fromCharCode(0);

/**
 * Parse `git diff --raw -M -z` into `DiffEntry[]`. The -z stream is NUL-delimited
 * tokens: a metadata token `:<oldmode> <newmode> <oldsha> <newsha> <status>`,
 * then ONE path - except rename/copy (`R<score>`/`C<score>`) is followed by TWO
 * paths (old then new). Under -z, non-ASCII paths are emitted raw (NOT C-quoted),
 * so they must be taken verbatim. Malformed RECORDS throw - bad metadata arity, a
 * missing path operand, an unrecognized status, or a non-`:` metadata token. The
 * only tolerated noise is empty tokens (the stream's trailing NUL terminator
 * produces one); they carry no record and are dropped, never partially parsed.
 */
export function parseRawDiff(out: string): DiffEntry[] {
  // Drop empty tokens: -z terminates each record (and the stream) with a NUL, so
  // split yields a trailing "" that is the terminator, not a malformed record.
  const tokens = out.split(NUL).filter((t) => t !== "");
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i++]!;
    if (!meta.startsWith(":")) {
      throw new DiffParseError(`expected ':' metadata token, got ${JSON.stringify(meta)}`);
    }
    const fields = meta.slice(1).split(" ");
    if (fields.length !== 5) {
      throw new DiffParseError(`metadata token has ${fields.length} fields, expected 5: ${JSON.stringify(meta)}`);
    }
    const [oldMode, newMode, , , status] = fields as [string, string, string, string, string];
    if (/^[RC]\d*$/.test(status)) {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (oldPath === undefined || path === undefined) {
        throw new DiffParseError(`rename/copy status '${status}' missing path operand(s)`);
      }
      entries.push({ status, oldMode, newMode, oldPath, path });
    } else if (/^[AMDT]$/.test(status)) {
      const path = tokens[i++];
      if (path === undefined) {
        throw new DiffParseError(`status '${status}' missing path operand`);
      }
      entries.push({ status, oldMode, newMode, path });
    } else {
      throw new DiffParseError(`unrecognized status form '${status}'`);
    }
  }
  return entries;
}

/**
 * The flat changed-path list - both sides of a rename/copy (old then new),
 * otherwise the single path. This is the ONE place paths are derived from
 * entries, so the tier floor, coverage check, and content scan all see an
 * identical path set for ordinary files.
 */
export function changedPaths(entries: readonly DiffEntry[]): string[] {
  return entries.flatMap((e) => (e.oldPath !== undefined ? [e.oldPath, e.path] : [e.path]));
}
