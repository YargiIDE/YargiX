/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The interactive terminal.
 *
 * One-shot mode answers a single prompt and exits; this keeps a session open,
 * so the conversation accumulates the way it does in the editor. Because a
 * human is present, approvals become a real question instead of the blanket
 * refusal the unattended path has to use.
 */

import * as readline from "readline";
import type { AgentEvent, Mode, Step } from "../agent/types";
import { MODES, type CliOptions } from "./args";
import { isIoError, readTextFile, writeTextFile } from "./io";
import { EventLog, describeLog, parseLogArg, resolvedPathsEqual, teeEmit } from "./logFile";
import {
  DEFAULT_SESSION_JSON,
  DEFAULT_SESSION_MD,
  parseSession,
  serializeSession,
  sessionToMarkdown,
  snapshotSession,
} from "./session";

export const BANNER = `YargiX interactive session. Type /help for commands, /exit to leave.`;

export const HELP = `Commands
  /help               show this
  /exit, /quit        end the session
  /clear              forget the conversation so far
  /mode <name>        switch mode (${MODES.join(", ")})
  /model <id>         switch model
  /auto [on|off]      approve actions without asking (currently: %AUTO%)
  /system [text]      extra instructions for this session (/system clear to drop)
  /history            how much conversation is being carried
  /cwd                show the working directory
  /tools              list the tools available in this mode
  /save [path]        write the conversation as JSON (default: .yargix/session.json)
  /load [path]        restore a JSON session (default: .yargix/session.json)
  /export [path]      write a markdown transcript (default: .yargix/session.md)
  /log [path|on|off]  mirror events as NDJSON (default on: .yargix/events.jsonl)

Anything else is sent to the agent. Ctrl+C stops the current run; Ctrl+D exits.`;

export type Command =
  | { kind: "prompt"; text: string }
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "history" }
  | { kind: "cwd" }
  | { kind: "tools" }
  | { kind: "mode"; value: string }
  | { kind: "model"; value: string }
  | { kind: "auto"; value?: boolean }
  | { kind: "system"; value: string }
  | { kind: "save"; value: string }
  | { kind: "load"; value: string }
  | { kind: "export"; value: string }
  | { kind: "log"; value: string }
  | { kind: "unknown"; name: string };

/**
 * Classify one line of input.
 *
 * Kept pure and separate from the loop so the command surface can be tested
 * without a terminal.
 */
export function parseCommand(line: string): Command {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "prompt", text };

  const [rawName, ...rest] = text.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const value = rest.join(" ").trim();

  switch (name) {
    case "exit":
    case "quit":
    case "q":
      return { kind: "exit" };
    case "help":
    case "h":
    case "?":
      return { kind: "help" };
    case "clear":
    case "reset":
      return { kind: "clear" };
    case "history":
      return { kind: "history" };
    case "cwd":
      return { kind: "cwd" };
    case "tools":
      return { kind: "tools" };
    case "mode":
      return { kind: "mode", value };
    case "model":
      return { kind: "model", value };
    case "auto": {
      const v = value.toLowerCase();
      if (v === "on" || v === "true" || v === "yes") return { kind: "auto", value: true };
      if (v === "off" || v === "false" || v === "no") return { kind: "auto", value: false };
      return { kind: "auto" }; // no argument: toggle
    }
    case "system":
      return { kind: "system", value };
    case "save":
      return { kind: "save", value };
    case "load":
      return { kind: "load", value };
    case "export":
      return { kind: "export", value };
    case "log":
      return { kind: "log", value };
    default:
      return { kind: "unknown", name };
  }
}

/** How an approval question was answered. */
export type ApprovalAnswer = "yes" | "no" | "always";

/** Map a typed reply to a decision; anything unrecognised is a refusal. */
export function parseApproval(input: string): ApprovalAnswer {
  const v = input.trim().toLowerCase();
  if (v === "a" || v === "always") return "always";
  if (v === "y" || v === "yes") return "yes";
  return "no";
}

/** A short, single-line description of what is being approved. */
export function describeAction(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.path === "string" ? i.path : undefined;
  const command = typeof i.command === "string" ? i.command : undefined;
  const url = typeof i.url === "string" ? i.url : undefined;
  const detail = command ?? path ?? url;
  if (!detail) return toolName;
  const trimmed = detail.length > 70 ? `${detail.slice(0, 70)}...` : detail;
  return `${toolName}: ${trimmed}`;
}

/**
 * Serialises terminal input into awaited lines.
 *
 * `readline.question` only reliably delivers one answer at a time on a TTY; a
 * piped or redirected stdin delivers every line at once and the extra ones are
 * dropped. Owning the `line` events and queueing them makes the session behave
 * the same whether a person is typing or a script is feeding it.
 */
export class LineReader {
  private queue: string[] = [];
  private waiting: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(rl: readline.Interface) {
    rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.queue.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      for (const fn of this.waiting.splice(0)) fn(null);
    });
  }

  /** The next line, or null once input has ended. */
  next(): Promise<string | null> {
    const buffered = this.queue.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

export interface ReplDeps {
  /** Injected so the REPL can be exercised without loading the whole agent. */
  runAgent: (opts: Record<string, unknown>) => Promise<void>;
  toolNamesFor: (mode: Mode) => string[];
}

interface SessionState {
  mode: Mode;
  model: string;
  auto: boolean;
  system: string;
  history: Step[];
}

/** Run the interactive session until the user leaves. Resolves with an exit code. */
export async function runRepl(options: CliOptions, deps: ReplDeps, incomingLog?: EventLog): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let log = incomingLog;
  const state: SessionState = {
    mode: options.mode,
    model: options.model,
    auto: options.auto,
    system: options.system,
    // Mutated in place by the agent, which is what carries the conversation.
    history: [],
  };

  const reader = new LineReader(rl);
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const ask = async (q: string): Promise<string> => {
    process.stdout.write(q);
    return (await reader.next()) ?? "";
  };

  out(BANNER);
  out(`mode: ${state.mode}   model: ${state.model || "(unset)"}   auto: ${state.auto ? "on" : "off"}`);
  if (state.system) out(`system: ${state.system.length > 70 ? `${state.system.slice(0, 70)}...` : state.system}`);
  if (log) out(`- ${describeLog(log)}`);

  let running: AbortController | undefined;
  // Ctrl+C stops the current run rather than killing the session.
  const onInterrupt = () => {
    if (running) {
      running.abort();
      out("\n- cancelled");
    } else {
      out("(/exit to leave)");
      rl.prompt();
    }
  };
  rl.on("SIGINT", onInterrupt);

  const queued: string[] = [];
  if (options.prompt) queued.push(options.prompt);

  for (;;) {
    let line: string | null;
    if (queued.length) {
      line = queued.shift() ?? null;
      if (line !== null) out(`${state.mode}> ${line}`);
    } else {
      process.stdout.write(`\n${state.mode}> `);
      line = await reader.next();
    }
    if (line === null) break; // Ctrl+D or end of piped input

    const cmd = parseCommand(line);
    if (cmd.kind === "empty") continue;
    if (cmd.kind === "exit") break;

    if (cmd.kind === "help") {
      out(HELP.replace("%AUTO%", state.auto ? "on" : "off"));
      continue;
    }
    if (cmd.kind === "clear") {
      state.history.length = 0;
      out("- conversation cleared");
      continue;
    }
    if (cmd.kind === "history") {
      out(`- ${state.history.length} step(s) carried`);
      continue;
    }
    if (cmd.kind === "cwd") {
      out(`- ${options.cwd}`);
      continue;
    }
    if (cmd.kind === "tools") {
      out(`- ${deps.toolNamesFor(state.mode).join(", ")}`);
      continue;
    }
    if (cmd.kind === "mode") {
      if (!MODES.includes(cmd.value as Mode)) {
        out(`- unknown mode "${cmd.value}" (expected: ${MODES.join(", ")})`);
        continue;
      }
      state.mode = cmd.value as Mode;
      out(`- mode: ${state.mode}`);
      continue;
    }
    if (cmd.kind === "model") {
      if (!cmd.value) {
        out(`- model: ${state.model || "(unset)"}`);
        continue;
      }
      state.model = cmd.value;
      out(`- model: ${state.model}`);
      continue;
    }
    if (cmd.kind === "auto") {
      state.auto = cmd.value ?? !state.auto;
      out(`- auto-approve: ${state.auto ? "on" : "off"}`);
      continue;
    }
    if (cmd.kind === "system") {
      const v = cmd.value.trim();
      if (!v) {
        out(state.system ? `- system: ${state.system}` : "- system: (none)");
        continue;
      }
      if (v.toLowerCase() === "clear" || v === "-") {
        state.system = "";
        out("- system instructions cleared");
        continue;
      }
      state.system = v;
      out("- system instructions updated");
      continue;
    }
    if (cmd.kind === "save") {
      const dest = cmd.value.trim() || DEFAULT_SESSION_JSON;
      const snap = snapshotSession({
        mode: state.mode,
        model: state.model,
        cwd: options.cwd,
        steps: state.history,
      });
      const written = await writeTextFile(dest, options.cwd, serializeSession(snap));
      out(isIoError(written) ? `- ${written.error}` : `- saved ${written.path} (${state.history.length} step(s))`);
      continue;
    }
    if (cmd.kind === "load") {
      const src = cmd.value.trim() || DEFAULT_SESSION_JSON;
      const loaded = await readTextFile(src, options.cwd, "session file");
      if (isIoError(loaded)) {
        out(`- ${loaded.error}`);
        continue;
      }
      const parsed = parseSession(loaded.text);
      if ("error" in parsed) {
        out(`- ${parsed.error}`);
        continue;
      }
      state.history.length = 0;
      for (const step of parsed.snapshot.steps) state.history.push(step);
      state.mode = parsed.snapshot.mode;
      if (parsed.snapshot.model) state.model = parsed.snapshot.model;
      out(`- loaded ${state.history.length} step(s), mode ${state.mode}`);
      continue;
    }
    if (cmd.kind === "export") {
      const dest = cmd.value.trim() || DEFAULT_SESSION_MD;
      const snap = snapshotSession({
        mode: state.mode,
        model: state.model,
        cwd: options.cwd,
        steps: state.history,
      });
      const written = await writeTextFile(dest, options.cwd, sessionToMarkdown(snap));
      out(isIoError(written) ? `- ${written.error}` : `- exported ${written.path}`);
      continue;
    }
    if (cmd.kind === "log") {
      const action = parseLogArg(cmd.value);
      if (action.action === "show") {
        out(`- ${describeLog(log)}`);
        continue;
      }
      if (action.action === "off") {
        await log?.close();
        log = undefined;
        out("- event log: off");
        continue;
      }
      if (options.output && resolvedPathsEqual(action.path, options.output, options.cwd)) {
        out("- --log-file and --output cannot be the same path");
        continue;
      }
      const opened = await EventLog.open(action.path, options.cwd);
      if (isIoError(opened)) {
        out(`- ${opened.error}`);
        continue;
      }
      await log?.close();
      log = opened;
      out(`- ${describeLog(log)}`);
      continue;
    }
    if (cmd.kind === "unknown") {
      out(`- unknown command "/${cmd.name}" (try /help)`);
      continue;
    }

    // ---- a real prompt: run the agent ----
    const controller = new AbortController();
    running = controller;
    const announced = new Set<string>();
    let midLine = false;
    const endLine = () => {
      if (midLine) {
        process.stdout.write("\n");
        midLine = false;
      }
    };
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeout * 1000);
      timeoutTimer.unref();
    }
    let finalText = "";
    let gotResult = false;

    try {
      await deps.runAgent({
        model: state.model,
        mode: state.mode,
        prompt: cmd.text,
        history: state.history,
        extraInstructions: state.system || undefined,
        approve: async (toolName: string, input: unknown) => {
          if (state.auto) return true;
          endLine();
          const answer = parseApproval(await ask(`  allow ${describeAction(toolName, input)}? [y/N/a] `));
          if (answer === "always") {
            state.auto = true;
            return true;
          }
          if (answer === "yes") return true;
          return { approved: false as const, blockedSubject: toolName };
        },
        signal: controller.signal,
        emit: teeEmit((ev: AgentEvent) => {
          if (ev.type === "text-delta") {
            process.stdout.write(ev.text);
            midLine = !ev.text.endsWith("\n");
            return;
          }
          if (ev.type === "tool-call-started") {
            if (announced.has(ev.callId)) return;
            announced.add(ev.callId);
            endLine();
            process.stdout.write(`- ${ev.name}\n`);
            return;
          }
          if (ev.type === "run-result") {
            finalText = ev.text;
            gotResult = true;
            return;
          }
          if (ev.type === "error") {
            endLine();
            process.stdout.write(`x ${ev.message}\n`);
          }
        }, log),
      });
    } catch (error) {
      endLine();
      out(`x ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      endLine();
      running = undefined;
    }
    if (timedOut) out(`- timed out after ${options.timeout}s`);
    if (options.output && gotResult) {
      const written = await writeTextFile(options.output, options.cwd, finalText);
      if (isIoError(written)) out(`- ${written.error}`);
    }
  }

  rl.off("SIGINT", onInterrupt);
  rl.close();
  await log?.close();
  out("bye");
  return 0;
}
