import { normalizePath } from "../tier/glob.js";
import { jsonErrorLocation, stripJsonc } from "./jsonc.js";
import {
  classifyToken,
  collapseAgainst,
  configDir,
  isGlobPattern,
  isRemoteUrl,
  ReferenceResolutionError,
  REPO_RELATIVE_REMEDIATION,
  type ExtractedReferences,
} from "./path.js";

/**
 * `opencode-json` extractor (JSON and JSONC) - resolve the in-repo files an
 * `opencode.json`/`.jsonc` loads into agent context (opencode.ai/docs/config).
 *
 *  - `instructions: string[]` -> exact paths / glob patterns, resolved relative
 *    to the CONTAINING config file's directory (first-party), NOT repo-root. A
 *    nested `packages/a/opencode.jsonc` with `"prompts/x.md"` floors
 *    `packages/a/prompts/x.md`. Remote-URL entries (http/https) are skipped.
 *  - `{file:...}` substitutions in INSTRUCTION-BEARING fields only
 *    (`agent.*.prompt`, deprecated `mode.*.prompt`) -> its path, also
 *    config-dir-relative. A `{file:}` anywhere else (e.g. a provider `apiKey`)
 *    must NOT floor.
 *  - Absolute / `~`-home instruction or `{file:}` paths BLOCK (fail closed).
 *  - Unparseable config BLOCKS (fail closed) - the resolver throws.
 *
 * JSONC is normalized with a STRING-AWARE lexer (see jsonc.ts): a regex stripper
 * corrupts `"guides/**\/*.guide.md"` and under-floors it.
 */
export function extractOpencodeReferences(configPath: string, content: string): ExtractedReferences {
  const stripped = stripJsonc(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch (err) {
    throw new ReferenceResolutionError({
      sourceConfig: configPath,
      location: jsonErrorLocation(err, stripped),
      extractor: "opencode-json",
      token: "(config document)",
      reason: "unparseable",
      remediation: "ensure the opencode config is valid JSON/JSONC",
    });
  }

  const dir = configDir(configPath);
  const exact: string[] = [];
  const globs: string[] = [];

  /** Resolve one reference path (instruction entry or `{file:}` payload) into the
   *  exact/glob sets. Blocks on absolute/home; skips remote URLs and repo-escapes. */
  const add = (rawPath: string, pointer: string): void => {
    const token = rawPath.trim();
    if (token === "") return; // empty/malformed entry: nothing to floor
    if (isRemoteUrl(token)) return; // deterministically external
    const cls = classifyToken(token);
    if (cls.kind === "home" || cls.kind === "absolute") {
      throw new ReferenceResolutionError({
        sourceConfig: configPath,
        location: pointer,
        extractor: "opencode-json",
        token: rawPath,
        reason: cls.kind,
        remediation: REPO_RELATIVE_REMEDIATION,
      });
    }
    const collapsed = collapseAgainst(dir, cls.path);
    if (collapsed.kind === "escape") return; // provably outside repo
    if (isGlobPattern(collapsed.path)) globs.push(collapsed.path);
    else exact.push(normalizePath(collapsed.path));
  };

  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    const instructions = obj["instructions"];
    if (Array.isArray(instructions)) {
      instructions.forEach((entry, idx) => {
        if (typeof entry === "string") add(entry, `/instructions/${idx}`);
      });
    }

    // Instruction-bearing prompt fields only. `agent.*.prompt` (current) and
    // `mode.*.prompt` (deprecated) may carry `{file:path}` substitutions.
    for (const field of ["agent", "mode"] as const) {
      const container = obj[field];
      if (container === null || typeof container !== "object") continue;
      for (const [name, cfg] of Object.entries(container as Record<string, unknown>)) {
        if (cfg === null || typeof cfg !== "object") continue;
        const prompt = (cfg as Record<string, unknown>)["prompt"];
        if (typeof prompt !== "string") continue;
        for (const filePath of extractFileRefs(prompt)) {
          add(filePath, `/${field}/${name}/prompt`);
        }
      }
    }
  }

  return { exact, globs };
}

/** Extract every `{file:PATH}` payload from an instruction-bearing string. */
function extractFileRefs(s: string): string[] {
  const out: string[] = [];
  const re = /\{file:([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]!);
  return out;
}
