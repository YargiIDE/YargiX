/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Shared ignore lists. Kept in their own module so the file-scanning layer
// (fileScan.ts) does not have to import shared.ts, which would be circular.

/** Directories never walked/listed (tools + indexing). */
export const IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "target",
  "vendor",
  "Pods",
  ".gradle",
  ".idea",
  ".vscode",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  "site-packages",
]);

/** Extensions we never read as text (skipped by content search). */
export const BINARY_EXTS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".o", ".a", ".lib",
  ".zip", ".gz", ".7z", ".rar", ".tar", ".bz2", ".xz", ".zst",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".tif", ".tiff",
  ".mp3", ".mp4", ".wav", ".flac", ".ogg", ".avi", ".mov", ".mkv", ".webm",
  ".class", ".pyc", ".pyo", ".wasm", ".node", ".pdb", ".obj",
  ".db", ".sqlite", ".sqlite3", ".mo",
]);

/** Files that are text but almost never worth searching. */
export const NOISE_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "go.sum",
]);

/** ripgrep --glob exclusions matching the NOISE_FILES/isNoisePath heuristics. */
export const NOISE_GLOBS = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/composer.lock",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
];

/** Heuristic: is this path unlikely to be worth searching by content? */
export function isNoisePath(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (NOISE_FILES.has(base)) return true;
  if (/\.min\.(js|css)$/i.test(base)) return true;
  if (/\.map$/i.test(base)) return true;
  return false;
}
