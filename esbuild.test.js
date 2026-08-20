/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Bundles the unit tests so they run under plain Node.
 *
 * The extension's pure logic still imports `vscode`, which only exists inside an
 * Extension Host. Aliasing that import to a small stub lets the real modules run
 * in a normal `node --test` process — fast, and CI-friendly with no VS Code
 * download. Integration tests that need the real API stay under `vscode-test`.
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const UNIT_DIR = path.join(__dirname, "src", "test", "unit");
const OUT_DIR = path.join(__dirname, "out-test");

function testFiles() {
  if (!fs.existsSync(UNIT_DIR)) return [];
  return fs
    .readdirSync(UNIT_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(UNIT_DIR, f));
}

async function main() {
  const entryPoints = testFiles();
  if (!entryPoints.length) {
    console.error("no unit tests found in src/test/unit");
    process.exit(1);
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  await esbuild.build({
    entryPoints,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outdir: OUT_DIR,
    sourcemap: "inline",
    sourcesContent: false,
    logLevel: "info",
    alias: { vscode: path.join(__dirname, "src", "test", "stubs", "vscode.ts") },
  });

  // Run the built tests here rather than from an npm script: passing an explicit
  // file list avoids shell-glob quoting differences between platforms.
  const built = entryPoints.map((f) => path.join(OUT_DIR, path.basename(f).replace(/\.ts$/, ".js")));
  const code = await new Promise((resolve) => {
    spawn(process.execPath, ["--test", ...built], { stdio: "inherit" }).on("close", resolve);
  });
  process.exit(code ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
