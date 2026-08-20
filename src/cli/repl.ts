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

export const BANNER = `YargiX interactive session. Type /help for commands, /exit to leave.`;

export const HELP = `Commands
  /help               show this
  /exit, /quit        end the session
  /clear              forget the conversation so far
  /mode <name>        switch mode (${MODES.join(", ")})
  /model <id>         switch model
  /auto [on|off]      approve actions without asking (currently: %AUTO%)
  /history            how much conversation is being carried
  /cwd                show the working directory
  /tools              list the tools available in this mode

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
  history: Step[];
}

/** Run the interactive session until the user leaves. Resolves with an exit code. */
export async function runRepl(options: CliOptions, deps: ReplDeps): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const state: SessionState = {
    mode: options.mode,
    model: options.model,
    auto: options.auto,
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

  for (;;) {
    process.stdout.write(`\n${state.mode}> `);
    const line = await reader.next();
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

    try {
      await deps.runAgent({
        model: state.model,
        mode: state.mode,
        prompt: cmd.text,
        history: state.history,
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
        emit: (ev: AgentEvent) => {
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
          if (ev.type === "error") {
            endLine();
            process.stdout.write(`x ${ev.message}\n`);
          }
        },
      });
    } catch (error) {
      endLine();
      out(`x ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      endLine();
      running = undefined;
    }
  }

  rl.off("SIGINT", onInterrupt);
  rl.close();
  out("bye");
  return 0;
}
