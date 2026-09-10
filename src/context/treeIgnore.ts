/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Ignore matching for the workspace file tree injected into the prompt.
 *
 * Search/ListDir have their own walkers. This copy is intentionally small and
 * scoped to context so those surfaces can keep evolving on other branches.
 * Nested ignore files apply only under the directory that declared them.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { IGNORE } from "../agent/tools/ignore";

/** Same junk directories tools already skip (node_modules, dist, venvs, …). */
export const TREE_IGNORE = IGNORE;

/** Dot-directories that are project config, not noise. */
export const VISIBLE_DOT_DIRS = new Set([".cursor", ".yargix", ".github"]);

export const IGNORE_FILE_NAMES = [".gitignore", ".cursorignore", ".yargixignore"] as const;

const SECRET_NAMES = new Set([".env", ".env.local", ".env.production", ".env.development", ".env.test"]);

export interface IgnoreRule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
  /** Directory the rule was declared in, workspace-relative ("" for root). */
  base: string;
}

/** Translate one gitignore-style line into an anchored RegExp (wildmatch subset). */
function ignoreLineToRe(line: string, anchored: boolean): RegExp {
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

/** Parse a .gitignore / .cursorignore / .yargixignore body. */
export function parseIgnoreText(text: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.includes("/");
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
export function isPathIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const scoped = r.base ? (rel === r.base || rel.startsWith(`${r.base}/`) ? rel.slice(r.base.length + 1) : null) : rel;
    if (scoped == null) continue;
    if (r.re.test(scoped)) ignored = !r.negated;
  }
  return ignored;
}

export function isSecretName(name: string): boolean {
  if (SECRET_NAMES.has(name)) return true;
  if (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample") return true;
  if (/\.(pem|p12|pfx)$/i.test(name)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)(-[^.]+)?$/.test(name)) return true;
  return false;
}

/**
 * Should this directory entry be omitted from the prompt tree?
 *
 * Built-in junk and secrets cannot be un-ignored. Other dot names stay hidden
 * except the handful of project-config directories the agent needs. Ignore
 * files then hide whatever the repo asked to hide.
 */
export function shouldHideEntry(name: string, rel: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  if (name === ".git") return true;
  if (TREE_IGNORE.has(name)) return true;
  if (isSecretName(name)) return true;
  if (name.startsWith(".") && !VISIBLE_DOT_DIRS.has(name)) return true;
  return rules.length > 0 && isPathIgnored(rules, rel, isDir);
}

/** Load the three ignore filenames in one directory, if they exist. */
export async function loadIgnoreFiles(dirAbs: string, baseRel: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const name of IGNORE_FILE_NAMES) {
    try {
      const txt = await fs.readFile(path.join(dirAbs, name), "utf8");
      rules.push(...parseIgnoreText(txt, baseRel));
    } catch {
      /* missing or unreadable */
    }
  }
  return rules;
}
