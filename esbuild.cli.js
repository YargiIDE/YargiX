/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Bundles the CLI.
 *
 * `vscode` is aliased to the headless shim, so the same agent core that runs in
 * the extension host also runs in a terminal. The heavy optional deps stay
 * external: the CLI works without them, and semantic search simply reports that
 * it is unavailable rather than dragging native binaries into the bundle.
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const OUT = path.join(__dirname, "dist", "cli.js");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "src", "cli", "main.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: OUT,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
    banner: { js: "#!/usr/bin/env node" },
    alias: { vscode: path.join(__dirname, "src", "cli", "vscodeShim.ts") },
    external: ["@huggingface/transformers", "@huggingface/hub", "onnxruntime-node", "sharp"],
  });

  // Make it directly runnable on POSIX; harmless on Windows.
  try {
    fs.chmodSync(OUT, 0o755);
  } catch {
    // Filesystem does not support the bit — the npm bin shim still works.
  }
  console.log(`cli -> ${path.relative(__dirname, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} kb)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
