/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type { SubagentRunner, QuestionAsker } from "./types";

// Directories never walked/listed (tools + indexing).
export { IGNORE, BINARY_EXTS, NOISE_FILES, isNoisePath } from "./ignore";

// File discovery lives in fileScan.ts; re-exported here so existing tool
// imports keep working.
export {
  scanFiles,
  scanFilesCached,
  invalidateScanCache,
  compileGlob,
  globToRe,
  normalizeGlobPattern,
  scorePath,
  fuzzyScore,
  type ScannedFile,
  type ScanResult,
  type ScanOptions,
  type CompiledGlob,
} from "./fileScan";

// ---------------------------------------------------------------------------
// Per-tool hard timeouts (ms). Prevents a hung Grep/Glob/Shell/etc. from
// blocking the agent loop forever. Task/AskQuestion excluded (no outer budget).
// ---------------------------------------------------------------------------
export const TOOL_TIMEOUT_MS: Record<string, number> = {
  // Outer safety net: slightly above each tool's own cap so the tool can
  // clean up (kill process / mark done) before the loop aborts it.
  Shell: 120_000,
  AwaitShell: 300_000,
  Grep: 120_000,
  Glob: 120_000,
  FileSearch: 120_000,
  SemanticSearch: 300_000,
  SearchDocs: 300_000,
  ListDir: 60_000,
  Read: 300_000,
  ReadLints: 300_000,
  WebSearch: 300_000,
  WebFetch: 300_000,
  StrReplace: 300_000,
  Write: 300_000,
  Delete: 60_000,
  EditNotebook: 300_000,
  CallMcpTool: 180_000,
  FetchMcpResource: 120_000,
  ListMcpResources: 120_000,
  TodoWrite: 120_000,
  TodoRead: 120_000,
  WritePlan: 300_000,
  SwitchMode: 60_000,
};
/** Default when a tool has no explicit entry. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/** Tools that manage their own lifetime. Task has no outer budget — nested tools already time out. */
export const NO_TOOL_TIMEOUT = new Set(["AskQuestion", "Task"]);

/** Built-in defaults in seconds (for settings UI). */
export const DEFAULT_TOOL_TIMEOUTS_SEC: Record<string, number> = Object.fromEntries(
  Object.entries(TOOL_TIMEOUT_MS).map(([k, v]) => [k, Math.round(v / 1000)]),
);

/** User overrides from settings (tool name → seconds). Empty/missing = built-in default. */
let toolTimeoutOverridesSec: Record<string, number> = {};

/** Apply settings overrides (seconds). Call whenever feature config loads/changes. */
export function setToolTimeoutOverrides(sec: Record<string, number> | undefined): void {
  const next: Record<string, number> = {};
  if (sec) {
    for (const [k, v] of Object.entries(sec)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) next[k] = Math.floor(n);
    }
  }
  toolTimeoutOverridesSec = next;
}

/**
 * Race a tool promise against a hard timeout. On timeout rejects with an Error
 * whose message starts with "timeout:" so the loop can surface it cleanly.
 * Does not cancel the underlying work by itself — pass a linked AbortSignal
 * into the tool when possible (Shell/Grep honor it).
 * Always settles (never hangs) even if `p` never resolves.
 */
/**
 * Race a tool promise against a hard timeout.
 * On timeout: call `onTimeout` first (abort/kill), then reject immediately so
 * the loop can settle UI without waiting for the underlying work.
 * Late resolve/reject of `p` is ignored (no unhandled rejection).
 */
export function withToolTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  // ms <= 0: no outer race (AskQuestion manages its own lifetime) — still honor abort.
  if (!ms || ms <= 0) {
    if (!signal) {
      return Promise.resolve(p).catch((e) => {
        throw e instanceof Error ? e : new Error(String(e));
      });
    }
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(`aborted: ${label}`));
        return;
      }
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        try { onTimeout?.(); } catch { /* ignore */ }
        reject(new Error(`aborted: ${label}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(p).then(
        (v) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }
  const limit = ms;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      try { onTimeout?.(); } catch { /* ignore */ }
      reject(new Error(`aborted: ${label}`));
      return;
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      done(() => {
        try { onTimeout?.(); } catch { /* ignore */ }
        reject(new Error(`aborted: ${label}`));
      });
    };
    const timer = setTimeout(() => {
      done(() => {
        try { onTimeout?.(); } catch { /* ignore */ }
        reject(new Error(`timeout: ${label} exceeded ${Math.round(limit / 1000)}s`));
      });
    }, limit);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(p).then(
      (v) => done(() => resolve(v)),
      (e) => done(() => reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

/** Resolve the hard timeout for a tool name (0 = none). Honors settings overrides. */
export function toolTimeoutMs(name: string): number {
  if (NO_TOOL_TIMEOUT.has(name)) return 0;
  const overrideSec = toolTimeoutOverridesSec[name];
  if (overrideSec != null && overrideSec > 0) return overrideSec * 1000;
  return TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

// Stopwords for the keyword-based SemanticSearch fallback.
export const STOP = new Set([
  "where", "what", "which", "does", "with", "this", "that", "have", "from",
  "into", "when", "how", "the", "and", "for", "are", "work", "works", "handle", "handled",
]);

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/** Minimal LCS line diff, emitting only changed regions plus a little context. */
export function makeDiff(_filePath: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { t: " " | "+" | "-"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i++;
    } else {
      ops.push({ t: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });

  const CONTEXT = 3;
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== " ") {
      for (let x = Math.max(0, k - CONTEXT); x <= Math.min(ops.length - 1, k + CONTEXT); x++) keep[x] = true;
    }
  }

  const out: string[] = [];
  let prevKept = true;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      if (prevKept) out.push("…");
      prevKept = false;
      continue;
    }
    prevKept = true;
    const o = ops[k];
    out.push((o.t === " " ? "  " : o.t + " ") + o.line);
  }
  return out.join("\n");
}

/** 1-based line number of the first difference between two texts. */
export function firstDiffLine(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return Math.min(a.length, b.length) + 1;
}

/** Slugify a string for use as a filename. */
export function slugify(s: string): string {
  return (
    String(s || "plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "plan"
  );
}

/**
 * Locate a usable ripgrep binary (cached).
 *
 * VS Code ships ripgrep inside its own installation, so prefer that over PATH:
 * on Windows (and most user machines) `rg` is usually NOT on PATH, which used
 * to silently downgrade Grep to the much slower node fallback.
 */
let rgPathCached: string | null | undefined;

function bundledRgCandidates(): string[] {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const appRoot = process.env.VSCODE_CWD || "";
  const roots: string[] = [];
  try {
    // process.execPath -> .../Code.exe ; ripgrep lives under resources/app.
    const base = path.dirname(process.execPath);
    roots.push(path.join(base, "resources", "app"));
    roots.push(base);
  } catch { /* ignore */ }
  if (appRoot) roots.push(path.join(appRoot, "resources", "app"));
  const out: string[] = [];
  for (const r of roots) {
    out.push(path.join(r, "node_modules", "@vscode", "ripgrep", "bin", exe));
    out.push(path.join(r, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe));
    out.push(path.join(r, "node_modules", "vscode-ripgrep", "bin", exe));
  }
  return out;
}

function probeRg(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(v);
    };
    const timer = setTimeout(() => {
      try { c?.kill(); } catch { /* ignore */ }
      finish(false);
    }, 3_000);
    let c: ReturnType<typeof spawn> | undefined;
    try {
      c = spawn(cmd, ["--version"], { windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    c.on("error", () => finish(false));
    c.on("close", (code) => finish(code === 0));
  });
}

/** Absolute path or bare command for ripgrep; null when unavailable. */
export async function rgCommand(): Promise<string | null> {
  if (rgPathCached !== undefined) return rgPathCached;
  for (const cand of bundledRgCandidates()) {
    try {
      await fs.access(cand);
    } catch {
      continue;
    }
    if (await probeRg(cand)) {
      rgPathCached = cand;
      return cand;
    }
  }
  rgPathCached = (await probeRg("rg")) ? "rg" : null;
  return rgPathCached;
}

/** Whether ripgrep is available (cached; 3s probe timeout). */
export async function rgAvailable(): Promise<boolean> {
  return (await rgCommand()) != null;
}

// ---------------------------------------------------------------------------
// Background shell registry (shared by Shell + AwaitShell)
// ---------------------------------------------------------------------------

/** A pattern the agent wants to be notified about when it appears in output. */
export interface ShellNotify {
  re: RegExp;
  reason: string;
  debounceMs: number;
  lastNotified: number;
  /** Set by the loop so a match can emit an agent event. */
  emit?: (text: string) => void;
}

/** Lifecycle state of a shell command (drives the footer the model/UI reads). */
export type ShellStatus = "running" | "completed" | "failed" | "aborted" | "timeout" | "backgrounded";

export interface BgShell {
  id: string;
  command: string;
  /** The child shell running this command (unset until spawned). */
  proc?: ChildProcess;
  output: string;
  done: boolean;
  exitCode: number | null;
  startedAt: number;
  /** Wall-clock end (set once the command settles). */
  endedAt?: number;
  /** Directory the command ran in. */
  cwd?: string;
  status: ShellStatus;
  /** Signal that killed the underlying process, when known. */
  signal?: string;
  notify?: ShellNotify;
  /** Pull any new session output into this shell's buffer (for polling). */
  pump?: () => void;
  /** Live-output sink (streams the rendered card to the UI while running). */
  onChunk?: (chunk: string) => void;
}

export const bgShells = new Map<string, BgShell>();
let bgShellSeq = 0;
export function nextShellId(): string {
  return `sh_${++bgShellSeq}`;
}

/**
 * Feed new output into a shell, appending to its buffer and firing the
 * notify_on_output hook when the pattern matches (respecting debounce).
 */
export function pushShellOutput(sh: BgShell, chunk: string): void {
  sh.output += chunk;
  try { sh.onChunk?.(chunk); } catch { /* ignore */ }
  const n = sh.notify;
  if (!n || !n.emit) return;
  if (!n.re.test(chunk)) return;
  const now = Date.now();
  if (now - n.lastNotified < Math.max(5000, n.debounceMs)) return;
  n.lastNotified = now;
  n.emit(`Monitored ${n.reason}: matched in shell ${sh.id}`);
}

// ---------------------------------------------------------------------------
// Persistent stateful shell sessions (cwd/env persist across commands per run)
// ---------------------------------------------------------------------------

/**
 * A run's shell state. Each command runs in its own child shell (so it always
 * exits with a real exit code and never leaves the agent waiting on a live
 * REPL); only the working directory is carried across calls.
 */
export interface ShellSession {
  /** Directory the next command runs in (updated by `cd`). */
  cwd: string;
  /** Serializes command execution within a run. */
  queue: Promise<unknown>;
  /** Commands still running for this run (killed on dispose). */
  running: Set<ChildProcess>;
}

const IS_WIN = process.platform === "win32";
const shellSessions = new Map<string, ShellSession>();

/** Get (or lazily create) the shell state for a run key. */
export function getShellSession(key: string, cwd: string): ShellSession {
  let s = shellSessions.get(key);
  if (!s) {
    s = { cwd, queue: Promise.resolve(), running: new Set() };
    shellSessions.set(key, s);
  }
  return s;
}

/**
 * Spawn one command in its own shell. The command is passed through verbatim —
 * no wrapper script, no marker protocol — so its own exit code is the process
 * exit code and the shell terminates the moment the command does.
 */
export function spawnShellCommand(command: string, cwd: string): ChildProcess {
  const proc = IS_WIN
    ? spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      )
    : spawn("bash", ["--noprofile", "--norc", "-c", command], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb", PS1: "", PS2: "" },
      });
  // Nothing will ever type at this shell: close stdin so anything that prompts
  // reads EOF and exits instead of hanging forever.
  try {
    proc.stdin?.on("error", () => { /* ignore broken pipe */ });
    proc.stdin?.end();
  } catch { /* ignore */ }
  return proc;
}

/** Kill a command and everything it spawned (npm/pnpm scripts spawn children). */
export function killShellProcess(proc: ChildProcess): void {
  if (!proc || proc.exitCode != null || proc.signalCode) return;
  try {
    if (IS_WIN && proc.pid) {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => { try { proc.kill(); } catch { /* ignore */ } });
    } else if (proc.pid) {
      // Negative pid targets the process group when detached; fall back to the pid.
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    } else {
      proc.kill();
    }
  } catch { /* ignore */ }
}

/**
 * Carry `cd` across calls without keeping a live shell: a command that is only
 * a directory change updates the session cwd for subsequent commands.
 */
export function applyCwdSideEffect(session: ShellSession, command: string): void {
  const m = /^\s*cd\s+(?:\/d\s+)?("([^"]+)"|'([^']+)'|[^\s&|;]+)\s*$/i.exec(command);
  if (!m) return;
  const target = (m[2] ?? m[3] ?? m[1]).trim();
  if (!target || target === "-") return;
  const next = path.isAbsolute(target) ? target : path.resolve(session.cwd, target);
  session.cwd = next;
}

/** Tear down a run's shell state, killing anything still running. */
export function disposeShellSession(key: string): void {
  const s = shellSessions.get(key);
  if (!s) return;
  for (const proc of s.running) killShellProcess(proc);
  s.running.clear();
  shellSessions.delete(key);
}

/**
 * Wait until the shell finishes, `pattern` matches its output, or `ms` elapses.
 * Always resolves (never rejects). `ms <= 0` = one immediate pump + return.
 */
export function waitForShell(sh: BgShell, ms: number, pattern?: RegExp, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const deadline = Date.now() + Math.max(0, ms);
    const check = () => {
      try { sh.pump?.(); } catch { /* ignore */ }
      if (sh.done) return finish();
      if (pattern) {
        try {
          if (pattern.test(sh.output)) return finish();
        } catch { /* bad pattern mid-wait */ }
      }
      if (ms <= 0 || Date.now() >= deadline) return finish();
    };
    // Hard wall-clock: never tick forever even if setInterval stalls.
    const timer = setTimeout(finish, Math.max(ms, 0) + 250);
    const interval = setInterval(check, 50);
    check();
  });
}

/**
 * Render a shell's state. Header + footer carry metadata (pid, timings,
 * exit_code); AwaitShell's `pattern` deliberately matches only the body.
 */
/** Keep head + tail of long output; drop the middle (where most noise lives). */
function clampMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = s.length - max;
  return `${s.slice(0, head)}\n... [${dropped} chars truncated] ...\n${s.slice(s.length - tail)}`;
}

/** Collapse consecutive duplicate lines into "line ×N" (RTK-style log dedup). */
function collapseRepeats(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n >= 3 && lines[i].trim()) out.push(`${lines[i]}  [×${n}]`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out.join("\n");
}

/** Human-readable label for a settled shell status. */
function statusLabel(sh: BgShell): string {
  switch (sh.status) {
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "timeout":
      return "timed out";
    case "backgrounded":
      return "backgrounded";
    default:
      return "running";
  }
}

export function renderShell(sh: BgShell): string {
  const elapsed = (sh.endedAt ?? Date.now()) - sh.startedAt;
  // Trim trailing blank lines the shell echoes; collapse >2 blank lines and
  // runs of identical lines (progress spinners, repeated warnings).
  const cleaned = collapseRepeats(
    sh.output.replace(/\r(?!\n)/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
  );
  const body = clampMiddle(cleaned, 12000);
  if (sh.done) {
    const code = sh.exitCode ?? 0;
    const sig = sh.signal ? ` signal=${sh.signal}` : "";
    // Footer keeps a machine-readable exit_code (the UI colors the card from it).
    return `${body || "(no output)"}\n(exit_code=${code}${sig} ${statusLabel(sh)} in ${elapsed}ms)`;
  }
  // Still running: keep the poll hint + id so the model can await it.
  const head = `[shell ${sh.id}] running_for_ms=${elapsed}${sh.cwd ? ` cwd=${sh.cwd}` : ""}`;
  return `${head}\n${body}\n(still running - poll with AwaitShell shell_id="${sh.id}")`;
}

// ---------------------------------------------------------------------------
// Injected runners (set by the agent loop to avoid circular imports)
// ---------------------------------------------------------------------------

let SUBAGENT_RUNNER: SubagentRunner | undefined;
export function setSubagentRunner(runner: SubagentRunner | undefined): void {
  SUBAGENT_RUNNER = runner;
}
export function getSubagentRunner(): SubagentRunner | undefined {
  return SUBAGENT_RUNNER;
}

let QUESTION_ASKER: QuestionAsker | undefined;
export function setQuestionAsker(asker: QuestionAsker | undefined): void {
  QUESTION_ASKER = asker;
}
export function getQuestionAsker(): QuestionAsker | undefined {
  return QUESTION_ASKER;
}

/**
 * Whether leaving plan mode for an executing mode needs the user's sign-off.
 * Set from settings by the host; on by default so a plan is never self-approved.
 */
let PLAN_APPROVAL_REQUIRED = true;
export function setPlanApprovalRequired(required: boolean): void {
  PLAN_APPROVAL_REQUIRED = required;
}
export function planApprovalRequired(): boolean {
  return PLAN_APPROVAL_REQUIRED;
}
