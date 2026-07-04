import { normalizePath } from "../tier/glob.js";
import type { ForgeAdapter } from "../forge/adapter.js";
import {
  classifyToken,
  collapseAgainst,
  configDir,
  ReferenceResolutionError,
  REPO_RELATIVE_REMEDIATION,
  type ExtractedReferences,
} from "./path.js";

/**
 * `claude-md` extractor - resolve `@path` imports from a `CLAUDE.md` /
 * `CLAUDE.local.md` (and nested imported `.md` files) to the in-repo files the
 * agent loads into context (code.claude.com/docs/en/memory).
 *
 * Resolution is UNIFORM and first-party: every relative import (bare, `./`,
 * `../`) resolves relative to the CONTAINING file's directory - NOT repo-root and
 * NOT the working directory. `@docs/a.md` in the root config -> `docs/a.md`; a
 * BARE `@b.md` inside nested `docs/a.md` -> `docs/b.md` (the containing dir), not
 * `b.md`. Filesystem-absolute and `~`-home imports BLOCK (fail closed). An import
 * that collapses to escape the repo root is provably outside and skipped, but an
 * in-repo parent reference (`@../sibling/x.md`) is kept.
 *
 * Markdown code spans, fenced blocks, and backtick-literal `` `@x` `` are NOT
 * imports and are skipped. Recursion follows imported `.md` files to a maximum of
 * FOUR hops (the set the agent actually loads), with cycle detection.
 */

const MAX_HOPS = 4;

export async function extractClaudeMdReferences(
  repoReader: ForgeAdapter,
  ref: string,
  configPath: string,
  content: string,
): Promise<ExtractedReferences> {
  const exact: string[] = [];
  // Case-folded cycle-detection set, seeded with the config itself so an import
  // cycling back to CLAUDE.md terminates (the config is already floored directly).
  const visited = new Set<string>([configPath.toLowerCase()]);

  const walk = async (filePath: string, fileContent: string, depth: number): Promise<void> => {
    for (const target of parseClaudeImports(fileContent, filePath)) {
      const hop = depth + 1;
      if (hop > MAX_HOPS) continue; // no flooring past hop 4
      const key = target.toLowerCase();
      if (visited.has(key)) continue; // cycle detection
      visited.add(key);
      exact.push(target);
      // Recurse only into imported .md memory files, and only while a further hop
      // stays within the 4-hop budget. Non-.md targets are floored but not parsed.
      if (hop < MAX_HOPS && /\.md$/i.test(target)) {
        const res = await repoReader.getFile(ref, target);
        // A not-yet-existing import (absent at ref) is floored (so creating it is
        // graded) but cannot be recursed - not a block.
        if (res.kind === "ok") await walk(target, res.value.content, hop);
      }
    }
  };

  await walk(configPath, content, 0);
  return { exact, globs: [] };
}

/**
 * Parse `@import` targets from one markdown file's content, resolved against the
 * containing file's directory. Throws `ReferenceResolutionError` on an absolute /
 * `~`-home import (fail closed). Skips imports inside fenced code blocks and
 * inline code spans, and imports that escape the repo root.
 */
export function parseClaudeImports(content: string, containingPath: string): string[] {
  const dir = configDir(containingPath);
  const targets: string[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const trimmed = line.trimStart();
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      const marker = fence[1]![0]!; // "`" or "~"
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue; // the fence delimiter line itself is never an import
    }
    if (inFence) continue;

    const scan = stripInlineCode(line);
    // An import is `@<path>` at line start or after whitespace (so `user@host`
    // and email-like `@` mid-token are not imports). Path runs to whitespace.
    const re = /(^|\s)@(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      const rawToken = m[2]!;
      const cls = classifyToken(rawToken);
      if (cls.kind === "home" || cls.kind === "absolute") {
        throw new ReferenceResolutionError({
          sourceConfig: containingPath,
          location: `line ${li + 1}`,
          extractor: "claude-md",
          token: `@${rawToken}`,
          reason: cls.kind,
          remediation: REPO_RELATIVE_REMEDIATION,
        });
      }
      const collapsed = collapseAgainst(dir, cls.path);
      if (collapsed.kind === "escape") continue; // provably outside repo
      targets.push(normalizePath(collapsed.path));
    }
  }
  return targets;
}

/**
 * Remove inline code spans (backtick-delimited runs) from a single line so a
 * backtick-literal `` `@x` `` is not treated as an import. A run of N backticks
 * opens a span closed by the next run of N backticks; an unterminated run drops
 * the remainder of the line (it is code until end-of-line).
 */
function stripInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let n = 0;
      while (i + n < line.length && line[i + n] === "`") n++;
      const close = line.indexOf("`".repeat(n), i + n);
      if (close === -1) break; // unterminated span: rest of line is code
      i = close + n;
    } else {
      out += line[i]!;
      i++;
    }
  }
  return out;
}
