/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Packages the CLI as a standalone executable.
 *
 * Uses Node's built-in Single Executable Application support rather than a
 * bundler-specific packer: the runtime is the same Node that built it, and the
 * only extra tool is `postject`, fetched on demand the way the VSIX build
 * fetches vsce.
 *
 *   1. bundle the CLI (esbuild)
 *   2. turn it into a SEA blob
 *   3. copy the host node binary
 *   4. inject the blob into that copy
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname.replace(/[\\/]scripts$/, "");
const DIST = path.join(ROOT, "dist");
const BUNDLE = path.join(DIST, "cli.js");
const BLOB = path.join(DIST, "yargix.blob");
const CONFIG = path.join(DIST, "sea-config.json");
const EXE = path.join(DIST, process.platform === "win32" ? "yargix.exe" : "yargix");

/** Node marks the injected resource with this fuse. */
const FUSE = "fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32", ...opts });
}

function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(`missing ${path.relative(ROOT, BUNDLE)} — run "node esbuild.cli.js --production" first`);
    process.exit(1);
  }

  // 1) SEA config. `useSnapshot` stays off: the CLI reads argv and the
  //    environment at startup, which a snapshot would freeze.
  fs.writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        main: BUNDLE.replace(/\\/g, "/"),
        output: BLOB.replace(/\\/g, "/"),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
  );

  // 2) Build the blob with the running Node.
  console.log("- building SEA blob");
  run(process.execPath, ["--experimental-sea-config", CONFIG]);

  // 3) Copy the Node binary that will host it.
  console.log("- copying the node runtime");
  fs.copyFileSync(process.execPath, EXE);

  // Windows binaries are signed; the signature breaks once a resource is added,
  // so strip it first when the tooling is available.
  if (process.platform === "win32") {
    try {
      run("signtool", ["remove", "/s", EXE], { stdio: "ignore" });
    } catch {
      // signtool is part of the Windows SDK and is usually absent. Injection
      // still works; the copy simply carries an invalid signature.
    }
  }

  // 4) Inject. postject is fetched on demand rather than pinned as a dependency
  //    nobody needs to develop or run the extension.
  console.log("- injecting (postject)");
  const args = [
    "postject",
    EXE,
    "NODE_SEA_BLOB",
    BLOB,
    "--sentinel-fuse",
    `NODE_SEA_FUSE_${FUSE}`,
  ];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  run("pnpm", ["dlx", ...args]);

  const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
  console.log(`\nbuilt ${path.relative(ROOT, EXE)} (${mb} MB, ${os.platform()}-${os.arch()})`);
  console.log("try:  " + path.relative(ROOT, EXE) + " --help");
}

main();
