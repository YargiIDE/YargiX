/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The workspace tree that lands in the prompt.
 *
 * node_modules / gitignored build output / secrets must never appear, and
 * .github / .yargix must, so the model can see the project without drowning
 * in vendor trees.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { buildFileTree } from "../../context/fileTree";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-tree-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "main.ts"), "export {}\n");
  await fs.writeFile(path.join(root, "README.md"), "# hi\n");
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "");
  await fs.mkdir(path.join(root, "vendor"));
  await fs.writeFile(path.join(root, "vendor", "lib.c"), "");
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  await fs.mkdir(path.join(root, ".yargix", "memory"), { recursive: true });
  await fs.writeFile(path.join(root, ".yargix", "memory", "build.md"), "pnpm test\n");
  await fs.mkdir(path.join(root, ".cursor"));
  await fs.writeFile(path.join(root, ".cursor", "rules.md"), "");
  await fs.mkdir(path.join(root, ".secret"));
  await fs.writeFile(path.join(root, ".secret", "key"), "");
  return root;
}

test("the tree lists source files and skips built-in junk", async () => {
  const root = await fixture();
  const tree = await buildFileTree(root);
  assert.match(tree, /^src\/$/m);
  assert.match(tree, /main\.ts/);
  assert.match(tree, /README\.md/);
  assert.doesNotMatch(tree, /node_modules/);
  assert.doesNotMatch(tree, /vendor/);
  assert.doesNotMatch(tree, /(^|\n)\.git(\/|$)/);
});

test("secrets and anonymous dot directories stay hidden", async () => {
  const root = await fixture();
  const tree = await buildFileTree(root);
  assert.doesNotMatch(tree, /\.env/);
  assert.doesNotMatch(tree, /\.secret/);
});

test(".github, .yargix, and .cursor are visible", async () => {
  const root = await fixture();
  const tree = await buildFileTree(root);
  assert.match(tree, /^\.github\/$/m);
  assert.match(tree, /ci\.yml/);
  assert.match(tree, /^\.yargix\/$/m);
  assert.match(tree, /build\.md/);
  assert.match(tree, /^\.cursor\/$/m);
});

test(".gitignore hides matching names that are not in the built-in set", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "tmp"));
  await fs.writeFile(path.join(root, "tmp", "scratch.ts"), "");
  await fs.writeFile(path.join(root, ".gitignore"), "tmp/\n");
  const tree = await buildFileTree(root);
  assert.doesNotMatch(tree, /\btmp\b/);
  assert.doesNotMatch(tree, /scratch\.ts/);
  assert.match(tree, /main\.ts/);
});

test(".cursorignore and .yargixignore are honoured", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "scratch.log"), "noise\n");
  await fs.writeFile(path.join(root, "keep.ts"), "export {}\n");
  await fs.writeFile(path.join(root, ".cursorignore"), "*.log\n");
  await fs.mkdir(path.join(root, "generated"));
  await fs.writeFile(path.join(root, "generated", "out.ts"), "");
  await fs.writeFile(path.join(root, ".yargixignore"), "generated/\n");
  const tree = await buildFileTree(root);
  assert.doesNotMatch(tree, /scratch\.log/);
  assert.doesNotMatch(tree, /generated/);
  assert.match(tree, /keep\.ts/);
});

test("a nested gitignore only hides names under that directory", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "pkg"));
  await fs.writeFile(path.join(root, "pkg", "secret.txt"), "nope\n");
  await fs.writeFile(path.join(root, "pkg", ".gitignore"), "secret.txt\n");
  await fs.writeFile(path.join(root, "secret.txt"), "root one\n");
  const tree = await buildFileTree(root);
  assert.match(tree, /^secret\.txt$/m);
  assert.match(tree, /^pkg\/$/m);
  assert.doesNotMatch(tree, /pkg\/\n  secret\.txt/);
  // The nested file is omitted; the directory itself remains.
  assert.equal(tree.includes("  secret.txt"), false);
});

test("the budget cap inserts an ellipsis instead of dumping the repo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-tree-cap-"));
  for (let i = 0; i < 8; i++) {
    await fs.writeFile(path.join(root, `f${i}.ts`), "");
  }
  const tree = await buildFileTree(root, { budget: 3, maxDepth: 1 });
  assert.match(tree, /…/);
  assert.ok(tree.split("\n").length <= 4);
});
