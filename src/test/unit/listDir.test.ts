/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * ListDir is the model's first look at a folder. It must hide secrets and
 * build output that git already ignores, while still letting the model opt
 * back in with include_ignored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";
import { listDirTool } from "../../agent/tools/files";

function setWorkspaceRoot(dir: string): void {
  (vscode as unknown as { __setWorkspaceRoot: (d: string) => void }).__setWorkspaceRoot(dir);
}

async function tempWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-listdir-"));
  setWorkspaceRoot(root);
  return root;
}

function names(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("(") && !l.startsWith("..."));
}

test("ListDir lists directories first with a trailing slash", async () => {
  const root = await tempWorkspace();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "README.md"), "hi\n");
  await fs.writeFile(path.join(root, "package.json"), "{}\n");

  const result = await listDirTool.execute({ path: "." });
  assert.equal(names(result.output)[0], "src/");
  assert.ok(names(result.output).includes("README.md"));
  assert.match(result.output, /trailing \/ = directory/);

  await fs.rm(root, { recursive: true, force: true });
});

test("ListDir hides built-in noise directories such as node_modules", async () => {
  const root = await tempWorkspace();
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "index.ts"), "");

  const result = await listDirTool.execute({ path: "." });
  assert.deepEqual(names(result.output), ["index.ts"]);
  assert.match(result.output, /\(1 ignored\)/);

  await fs.rm(root, { recursive: true, force: true });
});

test("ListDir honors .gitignore, .cursorignore, and .yargixignore", async () => {
  const root = await tempWorkspace();
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(root, ".cursorignore"), ".env\n");
  await fs.writeFile(path.join(root, ".yargixignore"), "scratch/\n");
  await fs.writeFile(path.join(root, "debug.log"), "n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  await fs.mkdir(path.join(root, "scratch"));
  await fs.writeFile(path.join(root, "app.ts"), "");

  const result = await listDirTool.execute({ path: "." });
  const listed = names(result.output);
  assert.ok(listed.includes("app.ts"));
  assert.ok(listed.includes(".gitignore"));
  assert.ok(!listed.includes("debug.log"));
  assert.ok(!listed.includes(".env"));
  assert.ok(!listed.includes("scratch/"));
  assert.match(result.output, /\(3 ignored\)/);

  await fs.rm(root, { recursive: true, force: true });
});

test("nested ignore files only hide entries under their directory", async () => {
  const root = await tempWorkspace();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", ".gitignore"), "secret.bin\n");
  await fs.writeFile(path.join(root, "src", "secret.bin"), "x");
  await fs.writeFile(path.join(root, "src", "main.ts"), "");
  await fs.writeFile(path.join(root, "secret.bin"), "root copy");

  const nested = await listDirTool.execute({ path: "src" });
  assert.ok(names(nested.output).includes("main.ts"));
  assert.ok(!names(nested.output).includes("secret.bin"));
  assert.match(nested.output, /\(1 ignored\)/);

  const top = await listDirTool.execute({ path: "." });
  assert.ok(names(top.output).includes("secret.bin"), "root secret.bin is not covered by src/.gitignore");

  await fs.rm(root, { recursive: true, force: true });
});

test("include_ignored reveals hidden names except .git", async () => {
  const root = await tempWorkspace();
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(root, "debug.log"), "n");
  await fs.writeFile(path.join(root, "app.ts"), "");

  const hidden = await listDirTool.execute({ path: "." });
  assert.ok(!names(hidden.output).includes("debug.log"));
  assert.ok(!names(hidden.output).includes("node_modules/"));
  assert.ok(!names(hidden.output).includes(".git/"));

  const shown = await listDirTool.execute({ path: ".", include_ignored: true });
  assert.ok(names(shown.output).includes("debug.log"));
  assert.ok(names(shown.output).includes("node_modules/"));
  assert.ok(!names(shown.output).includes(".git/"));
  assert.ok(!shown.output.includes("ignored"));

  const asString = await listDirTool.execute({ path: ".", include_ignored: "true" });
  assert.ok(names(asString.output).includes("debug.log"));

  await fs.rm(root, { recursive: true, force: true });
});

test("ListDir reports an empty directory without pretending it failed", async () => {
  const root = await tempWorkspace();
  await fs.mkdir(path.join(root, "empty"));
  const result = await listDirTool.execute({ path: "empty" });
  assert.match(result.output, /\(empty\)/);
  await fs.rm(root, { recursive: true, force: true });
});

test("a missing path is an error, not an empty listing", async () => {
  const root = await tempWorkspace();
  const result = await listDirTool.execute({ path: "no-such-dir" });
  assert.match(result.output, /^error:/);
  await fs.rm(root, { recursive: true, force: true });
});
