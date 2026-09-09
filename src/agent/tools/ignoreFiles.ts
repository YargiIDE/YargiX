/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * gitignore-syntax matching for ListDir (and anything else that lists a
 * single directory rather than walking the tree).
 *
 * Glob / FileSearch / Grep already prune via fileScan's walker. ListDir is a
 * one-level readdir, so it has to load ignore files from the workspace root
 * down to the listed folder itself. Nested copies apply only under their
 * directory, matching git.
 */

import * as fs from "fs/promises";
import * as path from "path";

/** Ignore files consulted, in increasing precedence (last match wins). */
export const IGNORE_FILENAMES = [".gitignore", ".cursorignore", ".yargixignore"] as const;

export interface IgnoreRule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
  /** Directory the rule was declared in, workspace-relative ("" for root). */
  base: string;
}

/** Translate one gitignore line into an anchored RegExp (git wildmatch subset). */
export function ignoreLineToRe(line: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "*") {
      if (line[i + 1] === "*") {
        if (line[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = line.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        out += line.slice(i, end + 1).replace(/\\/g, "\\\\");
        i = end;
      }
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}$`);
}

/** Parse gitignore-syntax text into rules scoped to `base`. */
export function parseIgnoreText(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    try {
      rules.push({ re: ignoreLineToRe(line, anchored), negated, dirOnly, base });
    } catch {
      /* skip malformed pattern */
    }
  }
  return rules;
}

/** Last matching rule wins, mirroring git's precedence. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const scoped = r.base ? (rel === r.base || rel.startsWith(r.base + "/") ? rel.slice(r.base.length + 1) : null) : rel;
    if (scoped == null || scoped === "") continue;
    if (r.re.test(scoped)) ignored = !r.negated;
  }
  return ignored;
}

/**
 * Workspace-relative ancestor chain from the root down to `dirRel`, inclusive.
 * `""` / `"."` means the workspace root.
 */
export function ancestorRels(dirRel: string): string[] {
  const rel = dirRel.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
  const out = [""];
  if (!rel || rel === ".") return out;
  const parts = rel.split("/").filter((p) => p && p !== ".");
  let acc = "";
  for (const part of parts) {
    if (part === "..") continue;
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

/**
 * Load `.gitignore` / `.cursorignore` / `.yargixignore` from the workspace
 * root down to `dirRel`. Later files override earlier ones (git last-match).
 */
export async function loadIgnoreRules(
  workspaceRoot: string,
  dirRel: string,
  signal?: AbortSignal,
): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const base of ancestorRels(dirRel)) {
    if (signal?.aborted) break;
    const dirAbs = base ? path.join(workspaceRoot, ...base.split("/")) : workspaceRoot;
    const texts = await Promise.all(
      IGNORE_FILENAMES.map(async (name) => {
        try {
          return await fs.readFile(path.join(dirAbs, name), "utf8");
        } catch {
          return null;
        }
      }),
    );
    for (const txt of texts) {
      if (txt) rules.push(...parseIgnoreText(txt, base));
    }
  }
  return rules;
}

/** Coerce a tool-argument flag; models sometimes send the string `"true"`. */
export function truthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}
