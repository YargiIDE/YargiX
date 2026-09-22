/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX - AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Working-tree snapshot for `--diff`.
 *
 * Review and ask modes have no Shell tool, so a CI job that says "review the
 * uncommitted changes" cannot see the patch unless we attach it ourselves.
 * This module is that attachment: status + staged + unstaged + small untracked
 * files, with a hard size cap and the same sensitive-path redaction the
 * approval policy uses for `.env` / keys.
 *
 * Git is invoked with a timeout and never a pager or custom diff tool. The
 * runner and filesystem are injectable so the rules can be tested without a
 * real repository.
 */

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

/** Stay well under the 1 MB prompt cap so the user's own text still fits. */
export const MAX_DIFF_BYTES = 100_000;
/** Untracked files larger than this are named, not inlined. */
export const MAX_UNTRACKED_FILE_BYTES = 8_000;
export const GIT_TIMEOUT_MS = 5_000;

/**
 * Same idea as the approval-policy risky-path heuristic: names that usually
 * hold secrets. Duplicated on purpose so this module does not share a surface
 * with in-flight approval-policy work.
 */
const SENSITIVE_PATH =
  /(^|[\\/])(\.env[^\\/]*|.*\.(pem|key|pfx|p12)|id_rsa[^\\/]*|credentials[^\\/]*|secrets?[^\\/]*|\.git[\\/])$/i;

export function isSensitivePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (SENSITIVE_PATH.test(normalized)) return true;
  return normalized.split("/").some((part) => part.length > 0 && SENSITIVE_PATH.test(part));
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

export interface SnapshotStat {
  file: boolean;
  symlink: boolean;
  size: number;
}

export interface SnapshotFs {
  stat(absPath: string): Promise<SnapshotStat>;
  readFile(absPath: string): Promise<Buffer>;
}

export interface PorcelainEntry {
  code: string;
  path: string;
  from?: string;
  untracked: boolean;
}

export interface UntrackedBody {
  path: string;
  body: string | "redacted" | "binary" | "too-large" | "missing";
}

export interface GitSnapshotOk {
  ok: true;
  branch: string;
  redacted: string[];
  truncated: boolean;
  text: string;
  summary: string;
}

export interface GitSnapshotErr {
  ok: false;
  error: string;
}

export type GitSnapshot = GitSnapshotOk | GitSnapshotErr;

export function isGitSnapshotError(s: GitSnapshot): s is GitSnapshotErr {
  return !s.ok;
}

export interface CollectOptions {
  cwd: string;
  maxBytes?: number;
  timeoutMs?: number;
  run?: GitRunner;
  io?: SnapshotFs;
}

/** Prepend a snapshot block to the user prompt. Empty parts are dropped. */
export function composePromptWithDiff(prompt: string, snapshotText: string): string {
  const block = snapshotText.trim();
  const text = prompt.trimEnd();
  if (!block) return prompt;
  if (!text) return `${block}\n`;
  return `${block}\n\n${text}`;
}

/** Split one `git status --porcelain=v1` line into a path the rest of the code can use. */
export function parsePorcelainLine(line: string): PorcelainEntry | undefined {
  if (line.length < 4) return undefined;
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  const untracked = code === "??";
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1 && (code.includes("R") || code.includes("C"))) {
    return {
      code,
      from: unquoteGitPath(rest.slice(0, arrow)),
      path: unquoteGitPath(rest.slice(arrow + 4)),
      untracked,
    };
  }
  return { code, path: unquoteGitPath(rest), untracked };
}

export function parsePorcelain(status: string): PorcelainEntry[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parsePorcelainLine)
    .filter((e): e is PorcelainEntry => e !== undefined);
}

/** Paths named on a `diff --git a/... b/...` header, quotes undone. */
export function pathsFromDiffHeader(header: string): string[] {
  const rest = header.replace(/^diff --git\s+/, "").trim();
  return tokenizeGitPaths(rest).map(stripAbPrefix).filter(Boolean);
}

/**
 * Drop hunks whose path looks like a secret. Status still lists the name so
 * the model knows the file changed; it does not see the bytes.
 */
export function redactUnifiedDiff(patch: string): { patch: string; redacted: string[] } {
  if (!patch.trim()) return { patch: "", redacted: [] };
  const chunks = patch.split(/^(?=diff --git )/m);
  const redacted: string[] = [];
  const out: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const header = chunk.split(/\r?\n/, 1)[0] ?? "";
    const paths = pathsFromDiffHeader(header);
    const hit = paths.find(isSensitivePath);
    if (hit) {
      const label = paths[paths.length - 1] ?? hit;
      if (!redacted.includes(label)) redacted.push(label);
      const from = paths[0] ?? label;
      const to = paths[1] ?? from;
      out.push(`diff --git ${quoteGitPath(`a/${from}`)} ${quoteGitPath(`b/${to}`)}\n[redacted: sensitive path]\n`);
      continue;
    }
    out.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
  }
  return { patch: out.join(""), redacted };
}

export function formatWorkingTree(input: {
  branch: string;
  status: string;
  staged: string;
  unstaged: string;
  untracked: UntrackedBody[];
  redacted: string[];
  truncated: boolean;
}): string {
  const lines: string[] = [];
  const attrs = [`branch="${escapeAttr(input.branch)}"`];
  if (input.truncated) attrs.push('truncated="true"');
  lines.push(`<git_working_tree ${attrs.join(" ")}>`);
  lines.push(`Branch: ${input.branch}`);
  lines.push("Status:");
  lines.push(input.status.trim() ? input.status.trimEnd() : "clean");
  lines.push("");
  lines.push("Staged:");
  lines.push(input.staged.trim() ? input.staged.trimEnd() : "(none)");
  lines.push("");
  lines.push("Unstaged:");
  lines.push(input.unstaged.trim() ? input.unstaged.trimEnd() : "(none)");
  if (input.untracked.length) {
    lines.push("");
    lines.push("Untracked:");
    for (const file of input.untracked) {
      if (file.body === "redacted") {
        lines.push(`--- ${file.path} ---`);
        lines.push("[redacted: sensitive path]");
        continue;
      }
      if (file.body === "binary") {
        lines.push(`--- ${file.path} ---`);
        lines.push("[binary file omitted]");
        continue;
      }
      if (file.body === "too-large") {
        lines.push(`--- ${file.path} ---`);
        lines.push("[omitted: file larger than the untracked-file cap]");
        continue;
      }
      if (file.body === "missing") {
        lines.push(`--- ${file.path} ---`);
        lines.push("[omitted: file disappeared before it could be read]");
        continue;
      }
      lines.push(`--- ${file.path} ---`);
      lines.push(file.body.endsWith("\n") ? file.body.slice(0, -1) : file.body);
    }
  }
  if (input.redacted.length) {
    lines.push("");
    lines.push(`Redacted: ${input.redacted.join(", ")}`);
  }
  lines.push("</git_working_tree>");
  return lines.join("\n");
}

/**
 * Collect the working-tree snapshot for `--cwd`.
 *
 * Failures are returned, never thrown: the CLI prints one error and exits 2
 * so a CI job that asked for a diff does not start a blind review.
 */
export async function collectGitSnapshot(opts: CollectOptions): Promise<GitSnapshot> {
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_DIFF_BYTES;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : GIT_TIMEOUT_MS;
  const run = opts.run ?? ((args, cwd) => spawnGit(args, cwd, timeoutMs, maxBytes + 8_192));
  const io = opts.io ?? defaultFs();

  const inside = await run(["rev-parse", "--is-inside-work-tree"], opts.cwd);
  if (inside.timedOut) return { ok: false, error: "git timed out while checking the repository" };
  if (isMissingGit(inside)) return { ok: false, error: "git is not installed or is not on PATH" };
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, error: "not a git repository (pass -C to the repo root, or omit --diff)" };
  }

  const branchRes = await run(["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd);
  const branch =
    branchRes.code === 0 && branchRes.stdout.trim() ? branchRes.stdout.trim() : "(no branch)";

  const statusRes = await run(["status", "--porcelain=v1", "-unormal"], opts.cwd);
  if (statusRes.timedOut) return { ok: false, error: "git timed out while reading status" };
  if (statusRes.code !== 0) {
    return { ok: false, error: firstLine(statusRes.stderr) || "git status failed" };
  }

  const stagedRes = await run(["diff", "--cached", "--no-color", "--no-ext-diff"], opts.cwd);
  const unstagedRes = await run(["diff", "--no-color", "--no-ext-diff"], opts.cwd);
  if (stagedRes.timedOut || unstagedRes.timedOut) {
    return { ok: false, error: "git timed out while reading the working-tree diff" };
  }

  const stagedRedact = redactUnifiedDiff(stagedRes.stdout);
  const unstagedRedact = redactUnifiedDiff(unstagedRes.stdout);
  const redacted = unique([...stagedRedact.redacted, ...unstagedRedact.redacted]);

  const entries = parsePorcelain(statusRes.stdout);
  const untracked: UntrackedBody[] = [];
  for (const entry of entries) {
    if (!entry.untracked) continue;
    untracked.push(await readUntracked(entry.path, opts.cwd, io, redacted));
  }

  const changed = entries.filter((e) => !e.untracked).length;
  const summary = summarize(changed, untracked.length, redacted.length, branch);

  let truncated = Boolean(stagedRes.truncated || unstagedRes.truncated);
  let text = formatWorkingTree({
    branch,
    status: statusRes.stdout,
    staged: stagedRedact.patch,
    unstaged: unstagedRedact.patch,
    untracked,
    redacted,
    truncated,
  });
  const fitted = fitToBudget(text, maxBytes);
  if (fitted.truncated) truncated = true;
  text = fitted.text;

  return { ok: true, branch, redacted, truncated, text, summary };
}

export async function spawnGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  maxStdout = MAX_DIFF_BYTES + 8_192,
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args.slice(), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;
    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, stderr: stderr || "git timed out", code: -1, timedOut: true, truncated });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxStdout) {
        truncated = true;
        stdout = stdout.slice(0, maxStdout);
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_192) stderr = stderr.slice(0, 8_192);
    });
    child.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      finish({
        stdout: "",
        stderr: err.code === "ENOENT" ? "git is not installed or is not on PATH" : err.message,
        code: -1,
      });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? 1, truncated });
    });
  });
}

function defaultFs(): SnapshotFs {
  return {
    async stat(absPath) {
      const st = await fs.lstat(absPath);
      return { file: st.isFile(), symlink: st.isSymbolicLink(), size: st.size };
    },
    readFile: (absPath) => fs.readFile(absPath),
  };
}

async function readUntracked(
  relPath: string,
  cwd: string,
  io: SnapshotFs,
  redacted: string[],
): Promise<UntrackedBody> {
  if (isSensitivePath(relPath)) {
    if (!redacted.includes(relPath)) redacted.push(relPath);
    return { path: relPath, body: "redacted" };
  }
  const abs = path.resolve(cwd, relPath);
  try {
    const st = await io.stat(abs);
    if (st.symlink || !st.file) return { path: relPath, body: "binary" };
    if (st.size > MAX_UNTRACKED_FILE_BYTES) return { path: relPath, body: "too-large" };
    const buf = await io.readFile(abs);
    if (buf.includes(0)) return { path: relPath, body: "binary" };
    return { path: relPath, body: buf.toString("utf8") };
  } catch {
    return { path: relPath, body: "missing" };
  }
}

function fitToBudget(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const marker = "\n...[diff truncated to stay within the --diff budget]\n</git_working_tree>";
  const room = maxBytes - Buffer.byteLength(marker, "utf8");
  if (room < 80) {
    return {
      text: `<git_working_tree truncated="true">\n[diff omitted: over ${maxBytes} bytes]\n</git_working_tree>`,
      truncated: true,
    };
  }
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > room) {
    cut = cut.slice(0, Math.max(80, Math.floor(cut.length * 0.9)));
  }
  const close = cut.indexOf("</git_working_tree>");
  if (close !== -1) cut = cut.slice(0, close);
  return { text: `${cut.replace(/\s+$/, "")}${marker}`, truncated: true };
}

function summarize(changed: number, untracked: number, redacted: number, branch: string): string {
  const bits: string[] = [`branch ${branch}`];
  if (!changed && !untracked) bits.push("clean");
  else {
    if (changed) bits.push(`${changed} changed`);
    if (untracked) bits.push(`${untracked} untracked`);
  }
  if (redacted) bits.push(`${redacted} redacted`);
  return bits.join(", ");
}

function isMissingGit(result: GitRunResult): boolean {
  return /not installed|not on PATH|ENOENT/i.test(result.stderr);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function quoteGitPath(p: string): string {
  return /[\s"]/.test(p) ? `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : p;
}

function tokenizeGitPaths(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === " ") i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      let j = i + 1;
      let tok = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) {
          tok += s[j + 1];
          j += 2;
          continue;
        }
        tok += s[j++];
      }
      out.push(tok);
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== " ") j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

function stripAbPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
