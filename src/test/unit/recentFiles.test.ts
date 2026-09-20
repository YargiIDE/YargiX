/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { getRecentFiles } from "../../context/workspaceUtils";
// Same module instance the code under test sees as "vscode" (test alias).
import { window, Uri, __setWorkspaceRoot } from "../stubs/vscode";

const ROOT = path.resolve("fake-workspace");
const savedRoot = process.cwd();

function openTabs(...fsPaths: string[]): void {
  window.tabGroups.all.length = 0;
  window.tabGroups.all.push({ tabs: fsPaths.map((p) => ({ input: { uri: Uri.file(p) } })) });
}

beforeEach(() => {
  __setWorkspaceRoot(ROOT);
});

afterEach(() => {
  window.tabGroups.all.length = 0;
  __setWorkspaceRoot(savedRoot);
});

test("recent files come back workspace-relative, most recent first", () => {
  // Regression: the function computed the relative path for dedupe but pushed
  // the absolute fsPath, so dedupe never matched and callers got absolutes.
  openTabs(path.join(ROOT, "src", "a.ts"), path.join(ROOT, "README.md"));
  assert.deepEqual(getRecentFiles(), ["src/a.ts", "README.md"]);
});

test("duplicate tabs are reported once", () => {
  const file = path.join(ROOT, "src", "a.ts");
  openTabs(file, file);
  assert.deepEqual(getRecentFiles(), ["src/a.ts"]);
});

test("tabs outside the workspace are skipped", () => {
  openTabs(path.join(ROOT, "src", "a.ts"), path.join(path.dirname(ROOT), "other", "b.ts"));
  assert.deepEqual(getRecentFiles(), ["src/a.ts"]);
});

test("a sibling directory sharing the root prefix is still outside", () => {
  // Regression: a startsWith(root) check let `/fake-workspace2/x` through.
  openTabs(`${ROOT}2/sneaky.ts`);
  assert.deepEqual(getRecentFiles(), []);
});
