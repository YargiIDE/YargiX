/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Git context formatting and recent-file paths.
 *
 * Recent files used to leak absolute paths into the prompt (the relative
 * path was computed and then discarded). Git context is what the model sees
 * about the checkout, so a missing branch must stay empty rather than a
 * half-filled block.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { formatGitContext, getGitContext } from "../../context/workspaceContext";
import { getRecentFiles } from "../../context/workspaceUtils";
import { buildUserInfoBlock } from "../../context/cursorContext";
import { __setTabs, __setWorkspaceRoot, Uri } from "../stubs/vscode";

// ------------------------------------------------------------ formatGitContext

test("no branch means no git block", () => {
  assert.equal(formatGitContext({ branch: "", status: " M a.ts", recent: "abc hi" }), "");
});

test("a clean checkout still reports the branch", () => {
  const text = formatGitContext({ branch: "main", status: "", recent: "" });
  assert.equal(text, "Branch: main\nStatus: clean");
});

test("status and recent commits are included and capped", () => {
  const status = Array.from({ length: 40 }, (_, i) => ` M f${i}.ts`).join("\n");
  const recent = Array.from({ length: 8 }, (_, i) => `${i} msg`).join("\n");
  const text = formatGitContext({ branch: "feat/x", status, recent });
  assert.match(text, /^Branch: feat\/x$/m);
  assert.match(text, /Status:/);
  assert.equal(text.split("\n").filter((l) => l.startsWith(" M ")).length, 30);
  assert.match(text, /Recent:/);
  assert.equal(text.split("\n").filter((l) => /^\d+ msg$/.test(l)).length, 5);
});

test("a directory that is not a git repo yields an empty context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-nongit-"));
  assert.equal(await getGitContext(dir), "");
});

// ------------------------------------------------------------ getRecentFiles

test("recent files are workspace-relative posix paths, not absolute", () => {
  const root = path.join(os.tmpdir(), "yargix-ws");
  __setWorkspaceRoot(root);
  __setTabs([
    { input: { uri: Uri.file(path.join(root, "src", "main.ts")) } },
    { input: { uri: Uri.file(path.join(root, "src", "main.ts")) } },
    { input: { uri: Uri.file(path.join(root, "README.md")) } },
  ]);
  try {
    const files = getRecentFiles(root);
    assert.deepEqual(files, ["src/main.ts", "README.md"]);
    for (const f of files) {
      assert.equal(path.isAbsolute(f), false);
      assert.doesNotMatch(f, /\\/);
    }
  } finally {
    __setTabs([]);
    __setWorkspaceRoot(process.cwd());
  }
});

test("tabs outside the workspace are dropped", () => {
  const root = path.join(os.tmpdir(), "yargix-ws");
  __setWorkspaceRoot(root);
  __setTabs([{ input: { uri: Uri.file(path.join(os.tmpdir(), "elsewhere", "x.ts")) } }]);
  try {
    assert.deepEqual(getRecentFiles(root), []);
  } finally {
    __setTabs([]);
    __setWorkspaceRoot(process.cwd());
  }
});

// ------------------------------------------------------------ prompt wiring

test("user info includes the file tree and skips node_modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-ctx-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "app.ts"), "export {}\n");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "x.js"), "");
  __setWorkspaceRoot(root);
  try {
    const block = await buildUserInfoBlock({ enableWorkspaceContext: true });
    assert.match(block, /<workspace_files>/);
    assert.match(block, /app\.ts/);
    assert.doesNotMatch(block, /node_modules/);
  } finally {
    __setWorkspaceRoot(process.cwd());
  }
});

test("workspace context off omits the file tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-ctx-off-"));
  await fs.writeFile(path.join(root, "app.ts"), "");
  __setWorkspaceRoot(root);
  try {
    const block = await buildUserInfoBlock({ enableWorkspaceContext: false });
    assert.doesNotMatch(block, /<workspace_files>/);
    assert.doesNotMatch(block, /<git>/);
  } finally {
    __setWorkspaceRoot(process.cwd());
  }
});
