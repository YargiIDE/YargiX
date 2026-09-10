/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * A compact workspace tree for the cached prompt prefix.
 *
 * Depth and entry counts are capped so a huge checkout cannot blow the
 * context window. Ignored names are skipped, not listed.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { loadIgnoreFiles, shouldHideEntry, type IgnoreRule } from "./treeIgnore";

export const TREE_MAX_DEPTH = 3;
export const TREE_BUDGET = 200;

export interface FileTreeOptions {
  maxDepth?: number;
  budget?: number;
}

export async function buildFileTree(root: string, opts: FileTreeOptions = {}): Promise<string> {
  const maxDepth = opts.maxDepth ?? TREE_MAX_DEPTH;
  const budget = { n: opts.budget ?? TREE_BUDGET };
  const lines: string[] = [];
  const rules = await loadIgnoreFiles(root, "");
  await walk(root, "", 0, "", lines, budget, maxDepth, rules);
  return lines.join("\n");
}

async function walk(
  dirAbs: string,
  rel: string,
  depth: number,
  prefix: string,
  lines: string[],
  budget: { n: number },
  maxDepth: number,
  rules: IgnoreRule[],
): Promise<void> {
  if (depth > maxDepth || budget.n <= 0) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  let dirRules = rules;
  if (rel) {
    const nested = await loadIgnoreFiles(dirAbs, rel);
    if (nested.length) dirRules = rules.concat(nested);
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const isDir = e.isDirectory();
    if (shouldHideEntry(e.name, childRel, isDir, dirRules)) continue;
    if (budget.n <= 0) {
      lines.push(`${prefix}…`);
      return;
    }
    budget.n--;
    if (isDir) {
      lines.push(`${prefix}${e.name}/`);
      await walk(path.join(dirAbs, e.name), childRel, depth + 1, `${prefix}  `, lines, budget, maxDepth, dirRules);
    } else {
      lines.push(`${prefix}${e.name}`);
    }
  }
}
