/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX - AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Working-tree snapshots for `--diff`.
 *
 * The CLI must never start a review with a silent empty patch, leak `.env`
 * contents, or hang on a stuck git. These cases are the contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  MAX_DIFF_BYTES,
  collectGitSnapshot,
  composePromptWithDiff,
  formatWorkingTree,
  isGitSnapshotError,
  isSensitivePath,
  parsePorcelain,
  parsePorcelainLine,
  pathsFromDiffHeader,
  redactUnifiedDiff,
  type GitRunResult,
  type GitRunner,
  type SnapshotFs,
} from "../../cli/gitSnapshot";

function ok(stdout: string, code = 0): GitRunResult {
  return { stdout, stderr: "", code };
}

function fail(stderr: string, code = 128): GitRunResult {
  return { stdout: "", stderr, code };
}

function scripted(answers: Record<string, GitRunResult>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const hit = answers[key];
    if (!hit) throw new Error(`unexpected git ${key}`);
    return hit;
  };
}

const emptyIo: SnapshotFs = {
  stat: async () => {
    throw new Error("no file");
  },
  readFile: async () => {
    throw new Error("no file");
  },
};

// --------------------------------------------------------------- paths

test("sensitive paths cover the usual secret names", () => {
  for (const p of [".env", ".env.local", "certs/server.pem", "id_rsa", "id_rsa.pub", "secrets/token", "credentials", "foo.key"]) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ["src/index.ts", "README.md", "package.json", "env.ts", "keyboard.ts"]) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test("Windows separators and a leading ./ still redact", () => {
  assert.equal(isSensitivePath(".\\env.production"), false, "env.production is not .env*");
  assert.equal(isSensitivePath("./.env"), true);
  assert.equal(isSensitivePath("secrets\\api"), true);
});

// --------------------------------------------------------------- porcelain

test("porcelain lines keep the path and mark untracked files", () => {
  assert.deepEqual(parsePorcelainLine(" M src/cli/args.ts"), {
    code: " M",
    path: "src/cli/args.ts",
    untracked: false,
  });
  assert.deepEqual(parsePorcelainLine("?? src/cli/gitSnapshot.ts"), {
    code: "??",
    path: "src/cli/gitSnapshot.ts",
    untracked: true,
  });
});

test("renames expose both sides", () => {
  const row = parsePorcelainLine("R  old.ts -> new.ts");
  assert.deepEqual(row, { code: "R ", path: "new.ts", from: "old.ts", untracked: false });
});

test("quoted porcelain paths are unescaped", () => {
  const row = parsePorcelainLine('?? "foo bar.ts"');
  assert.equal(row?.path, "foo bar.ts");
});

test("parsePorcelain skips blank lines and junk", () => {
  const rows = parsePorcelain(" M a.ts\n\n?? b.ts\nxx\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.path, "a.ts");
  assert.equal(rows[1]?.path, "b.ts");
});

// --------------------------------------------------------------- headers

test("diff headers yield both sides, including quoted names", () => {
  assert.deepEqual(pathsFromDiffHeader("diff --git a/src/a.ts b/src/a.ts"), ["src/a.ts", "src/a.ts"]);
  assert.deepEqual(pathsFromDiffHeader('diff --git "a/foo bar" "b/foo bar"'), ["foo bar", "foo bar"]);
  assert.deepEqual(pathsFromDiffHeader("diff --git a/old.ts b/new.ts"), ["old.ts", "new.ts"]);
});

// --------------------------------------------------------------- redact

test("a sensitive hunk is replaced, not inlined", () => {
  const patch = [
    "diff --git a/src/ok.ts b/src/ok.ts",
    "--- a/src/ok.ts",
    "+++ b/src/ok.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-SECRET=1",
    "+SECRET=2",
    "",
  ].join("\n");
  const { patch: out, redacted } = redactUnifiedDiff(patch);
  assert.deepEqual(redacted, [".env"]);
  assert.match(out, /src\/ok\.ts/);
  assert.match(out, /\[redacted: sensitive path\]/);
  assert.doesNotMatch(out, /SECRET=2/);
});

test("an empty patch redacts nothing", () => {
  assert.deepEqual(redactUnifiedDiff(""), { patch: "", redacted: [] });
});

// --------------------------------------------------------------- format

test("a clean tree formats as clean, not as empty tags", () => {
  const text = formatWorkingTree({
    branch: "main",
    status: "",
    staged: "",
    unstaged: "",
    untracked: [],
    redacted: [],
    truncated: false,
  });
  assert.match(text, /branch="main"/);
  assert.match(text, /Status:\nclean/);
  assert.match(text, /Staged:\n\(none\)/);
  assert.match(text, /<\/git_working_tree>/);
});

test("untracked bodies carry their omission reason", () => {
  const text = formatWorkingTree({
    branch: "main",
    status: "?? .env\n?? blob.bin",
    staged: "",
    unstaged: "",
    untracked: [
      { path: ".env", body: "redacted" },
      { path: "blob.bin", body: "binary" },
      { path: "huge.txt", body: "too-large" },
    ],
    redacted: [".env"],
    truncated: false,
  });
  assert.match(text, /\[redacted: sensitive path\]/);
  assert.match(text, /\[binary file omitted\]/);
  assert.match(text, /untracked-file cap/);
  assert.match(text, /Redacted: \.env/);
});

test("composePromptWithDiff keeps the user text after the snapshot", () => {
  const out = composePromptWithDiff("review this", "<git_working_tree>\nStatus: clean\n</git_working_tree>");
  assert.match(out, /^<git_working_tree>/);
  assert.match(out, /review this$/);
});

test("composePromptWithDiff drops an empty snapshot", () => {
  assert.equal(composePromptWithDiff("review this", "  \n"), "review this");
});

// --------------------------------------------------------------- collect

test("a missing repository is an error, not an empty review", async () => {
  const snap = await collectGitSnapshot({
    cwd: "/tmp",
    run: scripted({
      "rev-parse --is-inside-work-tree": fail("fatal: not a git repository"),
    }),
    io: emptyIo,
  });
  assert.ok(isGitSnapshotError(snap));
  assert.match(snap.error, /not a git repository/);
});

test("a missing git binary is reported as such", async () => {
  const snap = await collectGitSnapshot({
    cwd: "/tmp",
    run: async () => fail("git is not installed or is not on PATH", -1),
    io: emptyIo,
  });
  assert.ok(isGitSnapshotError(snap));
  assert.match(snap.error, /not installed/);
});

test("a hung rev-parse does not start a run", async () => {
  const snap = await collectGitSnapshot({
    cwd: "/tmp",
    run: async () => ({ stdout: "", stderr: "git timed out", code: -1, timedOut: true }),
    io: emptyIo,
  });
  assert.ok(isGitSnapshotError(snap));
  assert.match(snap.error, /timed out/);
});

test("a clean repo produces a clean snapshot", async () => {
  const snap = await collectGitSnapshot({
    cwd: "/repo",
    run: scripted({
      "rev-parse --is-inside-work-tree": ok("true\n"),
      "rev-parse --abbrev-ref HEAD": ok("main\n"),
      "status --porcelain=v1 -unormal": ok(""),
      "diff --cached --no-color --no-ext-diff": ok(""),
      "diff --no-color --no-ext-diff": ok(""),
    }),
    io: emptyIo,
  });
  if (isGitSnapshotError(snap)) assert.fail(snap.error);
  assert.equal(snap.branch, "main");
  assert.match(snap.summary, /clean/);
  assert.match(snap.text, /Status:\nclean/);
  assert.equal(snap.truncated, false);
});

test("staged and unstaged patches are attached, secrets stripped", async () => {
  const staged = "diff --git a/src/a.ts b/src/a.ts\n+staged\n";
  const unstaged = [
    "diff --git a/src/b.ts b/src/b.ts",
    "+unstaged",
    "diff --git a/.env b/.env",
    "+SECRET=please-no",
    "",
  ].join("\n");
  const snap = await collectGitSnapshot({
    cwd: "/repo",
    run: scripted({
      "rev-parse --is-inside-work-tree": ok("true"),
      "rev-parse --abbrev-ref HEAD": ok("topic"),
      "status --porcelain=v1 -unormal": ok("M  src/a.ts\n M src/b.ts\n M .env\n"),
      "diff --cached --no-color --no-ext-diff": ok(staged),
      "diff --no-color --no-ext-diff": ok(unstaged),
    }),
    io: emptyIo,
  });
  if (isGitSnapshotError(snap)) assert.fail(snap.error);
  assert.match(snap.text, /\+staged/);
  assert.match(snap.text, /\+unstaged/);
  assert.doesNotMatch(snap.text, /SECRET=please-no/);
  assert.ok(snap.redacted.includes(".env"));
  assert.match(snap.summary, /3 changed/);
});

test("untracked text is inlined; secrets and binaries are not", async () => {
  const files: Record<string, { stat: { file: boolean; symlink: boolean; size: number }; body: Buffer }> = {
    "/repo/note.md": { stat: { file: true, symlink: false, size: 5 }, body: Buffer.from("hello") },
    "/repo/.env": { stat: { file: true, symlink: false, size: 4 }, body: Buffer.from("nope") },
    "/repo/pic.bin": { stat: { file: true, symlink: false, size: 3 }, body: Buffer.from([0, 1, 2]) },
  };
  const io: SnapshotFs = {
    async stat(abs) {
      const hit = files[abs];
      if (!hit) throw new Error(abs);
      return hit.stat;
    },
    async readFile(abs) {
      const hit = files[abs];
      if (!hit) throw new Error(abs);
      return hit.body;
    },
  };
  const snap = await collectGitSnapshot({
    cwd: "/repo",
    run: scripted({
      "rev-parse --is-inside-work-tree": ok("true"),
      "rev-parse --abbrev-ref HEAD": ok("main"),
      "status --porcelain=v1 -unormal": ok("?? note.md\n?? .env\n?? pic.bin\n"),
      "diff --cached --no-color --no-ext-diff": ok(""),
      "diff --no-color --no-ext-diff": ok(""),
    }),
    io,
  });
  if (isGitSnapshotError(snap)) assert.fail(snap.error);
  assert.match(snap.text, /--- note.md ---\nhello/);
  assert.match(snap.text, /--- \.env ---\n\[redacted: sensitive path\]/);
  assert.match(snap.text, /--- pic.bin ---\n\[binary file omitted\]/);
  assert.doesNotMatch(snap.text, /nope/);
});

test("an oversized snapshot is truncated and still well-formed", async () => {
  const hunk = `diff --git a/big.ts b/big.ts\n+${"x".repeat(8_000)}\n`;
  const snap = await collectGitSnapshot({
    cwd: "/repo",
    maxBytes: 400,
    run: scripted({
      "rev-parse --is-inside-work-tree": ok("true"),
      "rev-parse --abbrev-ref HEAD": ok("main"),
      "status --porcelain=v1 -unormal": ok(" M big.ts"),
      "diff --cached --no-color --no-ext-diff": ok(""),
      "diff --no-color --no-ext-diff": ok(hunk),
    }),
    io: emptyIo,
  });
  if (isGitSnapshotError(snap)) assert.fail(snap.error);
  assert.equal(snap.truncated, true);
  assert.ok(Buffer.byteLength(snap.text, "utf8") <= 400);
  assert.match(snap.text, /truncated/);
  assert.match(snap.text, /<\/git_working_tree>/);
});

test("the default budget is the documented cap", () => {
  assert.equal(MAX_DIFF_BYTES, 100_000);
});

// --------------------------------------------------------------- real git

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

test("a real repository snapshot includes the uncommitted edit", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yargix-diff-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "YargiX test"]);
  await fs.writeFile(path.join(root, "readme.txt"), "hello\n");
  git(["add", "readme.txt"]);
  git(["commit", "-m", "init"]);
  await fs.writeFile(path.join(root, ".env"), "SECRET=old\n");
  git(["add", "-f", ".env"]);
  git(["commit", "-m", "keep env tracked so the snapshot must redact it"]);
  await fs.writeFile(path.join(root, "readme.txt"), "hello\nworld\n");
  await fs.writeFile(path.join(root, "extra.txt"), "new file\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=do-not-leak\n");

  const snap = await collectGitSnapshot({ cwd: root });
  if (isGitSnapshotError(snap)) assert.fail(snap.error);
  assert.match(snap.text, /\+world/);
  assert.match(snap.text, /--- extra.txt ---\nnew file/);
  assert.doesNotMatch(snap.text, /SECRET=do-not-leak/);
  assert.ok(snap.redacted.includes(".env"));
});
