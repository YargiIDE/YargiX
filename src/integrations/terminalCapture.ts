/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Captures what happens in the user's *own* terminals.
 *
 * The agent's Shell tool runs its own child processes; this is the other half —
 * the commands the user types. VS Code's shell-integration API (stable since
 * 1.93) reports each execution's command line, streamed output, and exit code,
 * so `@terminal` mentions and the ReadTerminal tool can carry real content
 * instead of just a terminal name.
 */

import * as vscode from "vscode";

/** One command the user ran in a terminal. */
export interface TerminalExecution {
  terminal: string;
  command: string;
  output: string;
  /** undefined while running, or when the shell reported no code. */
  exitCode: number | undefined;
  cwd?: string;
  startedAt: number;
  endedAt?: number;
  running: boolean;
}

/** Executions kept in memory (oldest dropped first). */
const MAX_EXECUTIONS = 40;
/** Per-execution output cap; the middle is elided when a command floods. */
const MAX_OUTPUT = 16_000;

const history: TerminalExecution[] = [];
const changed = new vscode.EventEmitter<void>();
export const onDidChangeTerminalHistory = changed.event;

// Built from a char code so the source carries no literal control character.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]`, "g");

/** Strip ANSI escapes and stray control bytes so the model sees plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\r\n?/g, "\n");
}

/** Keep the head and tail of an over-long capture. */
function clamp(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  const dropped = text.length - MAX_OUTPUT;
  return `${text.slice(0, half)}\n… [${dropped} characters elided] …\n${text.slice(-half)}`;
}

function push(exec: TerminalExecution) {
  history.push(exec);
  while (history.length > MAX_EXECUTIONS) history.shift();
}

export interface HistoryQuery {
  /** Only executions from this terminal name. */
  terminal?: string;
  /** Only executions that exited non-zero. */
  onlyFailed?: boolean;
  /** Most recent N (default 10). */
  limit?: number;
}

/** Recent executions, newest last. */
export function recentExecutions(q: HistoryQuery = {}): TerminalExecution[] {
  const limit = Math.max(1, Math.min(q.limit ?? 10, MAX_EXECUTIONS));
  let list = history;
  if (q.terminal) list = list.filter((e) => e.terminal === q.terminal);
  if (q.onlyFailed) list = list.filter((e) => e.exitCode !== undefined && e.exitCode !== 0);
  return list.slice(-limit);
}

/** The most recent failed execution, if any. */
export function lastFailedExecution(): TerminalExecution | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (!e.running && e.exitCode !== undefined && e.exitCode !== 0) return e;
  }
  return undefined;
}

/** True when nothing has been captured (shell integration may be unavailable). */
export function isEmpty(): boolean {
  return history.length === 0;
}

/** Render executions as a text block for the model. */
export function formatExecutions(list: TerminalExecution[]): string {
  if (!list.length) return "(no captured terminal activity)";
  return list
    .map((e) => {
      const status = e.running
        ? "running"
        : e.exitCode === undefined
          ? "finished (exit code unknown)"
          : `exit_code=${e.exitCode}`;
      const where = e.cwd ? ` cwd="${e.cwd}"` : "";
      const body = e.output.trim() || "(no output)";
      return `$ ${e.command}\n[terminal="${e.terminal}"${where} ${status}]\n${body}`;
    })
    .join("\n\n");
}

/** Start capturing. Safe to call when the running VS Code lacks shell integration. */
export function registerTerminalCapture(context: vscode.ExtensionContext): void {
  // Older hosts (or builds without the API) simply capture nothing.
  const onStart = vscode.window.onDidStartTerminalShellExecution;
  const onEnd = vscode.window.onDidEndTerminalShellExecution;
  if (!onStart || !onEnd) return;

  const live = new Map<vscode.TerminalShellExecution, TerminalExecution>();

  context.subscriptions.push(
    onStart((e) => {
      const record: TerminalExecution = {
        terminal: e.terminal.name,
        command: e.execution.commandLine.value || "",
        output: "",
        exitCode: undefined,
        cwd: e.execution.cwd?.fsPath ?? e.terminal.shellIntegration?.cwd?.fsPath,
        startedAt: Date.now(),
        running: true,
      };
      live.set(e.execution, record);
      push(record);
      changed.fire();

      // `read()` may only be consumed once, and only while the command runs.
      void (async () => {
        try {
          for await (const chunk of e.execution.read()) {
            record.output = clamp(record.output + stripAnsi(chunk));
          }
        } catch {
          // Stream ended abruptly (terminal closed) — keep whatever we captured.
        }
      })();
    }),

    onEnd((e) => {
      const record = live.get(e.execution);
      live.delete(e.execution);
      if (!record) return;
      record.exitCode = e.exitCode;
      record.endedAt = Date.now();
      record.running = false;
      // The command line firms up once the execution ends.
      if (e.execution.commandLine.value) record.command = e.execution.commandLine.value;
      changed.fire();
    }),

    changed,
  );
}
