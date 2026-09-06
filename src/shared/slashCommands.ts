/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Slash commands for the editor sidebar composer.
 *
 * Same idea as the CLI REPL: a leading `/word` is a command, not a prompt.
 * Unix paths (`/src/cli/main.ts`) stay prompts — only a single token without
 * further slashes is a command, so a typo never silently spends a model call.
 */

import type { Mode } from "./turns";
import { parseExportFormat, type TranscriptFormat } from "./transcript";

export const SIDEBAR_MODES: Mode[] = ["agent", "ask", "plan", "debug", "review", "multitask", "project"];

export const SIDEBAR_HELP = `Commands
  /help               show this
  /clear, /new        start a new chat (history stays)
  /mode <name>        switch mode (${SIDEBAR_MODES.join(", ")})
  /model [id]         switch model, or show the current one
  /export [md|json]   save a transcript (markdown by default)
  /settings           open YargiX settings

A path that starts with / is sent to the agent. Anything else starting with / is a command.`;

export type SidebarCommand =
  | { kind: "prompt"; text: string }
  | { kind: "empty" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "export"; format: TranscriptFormat }
  | { kind: "mode"; value: string }
  | { kind: "model"; value: string }
  | { kind: "settings" }
  | { kind: "unknown"; name: string };

export type SidebarAction =
  | { type: "none" }
  | { type: "newConversation" }
  | { type: "export"; format: TranscriptFormat }
  | { type: "setMode"; mode: Mode }
  | { type: "setModel"; model: string }
  | { type: "openSettings" };

export interface SlashResult {
  action: SidebarAction;
  notice: string;
  ok: boolean;
}

/**
 * Classify one composer submission.
 *
 * Kept pure so the command surface can be tested without a webview.
 */
export function parseSidebarCommand(line: string): SidebarCommand {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "prompt", text };

  const [rawName, ...rest] = text.slice(1).split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const value = rest.join(" ").trim();

  // `/src/foo.ts` or `// comment` — not a command.
  if (!name || name.includes("/")) return { kind: "prompt", text };

  switch (name) {
    case "help":
    case "h":
    case "?":
      return { kind: "help" };
    case "clear":
    case "reset":
    case "new":
      return { kind: "clear" };
    case "export": {
      const format = parseExportFormat(value) ?? "markdown";
      return { kind: "export", format };
    }
    case "mode":
      return { kind: "mode", value };
    case "model":
      return { kind: "model", value };
    case "settings":
    case "prefs":
    case "config":
      return { kind: "settings" };
    default:
      return { kind: "unknown", name };
  }
}

/** Turn a parsed command into a host action plus the notice shown in the chat. */
export function interpretSidebarCommand(
  cmd: SidebarCommand,
  ctx: { mode: Mode; model: string },
): SlashResult {
  switch (cmd.kind) {
    case "empty":
    case "prompt":
      return { action: { type: "none" }, notice: "", ok: true };
    case "help":
      return { action: { type: "none" }, notice: SIDEBAR_HELP, ok: true };
    case "clear":
      return { action: { type: "newConversation" }, notice: "Started a new chat.", ok: true };
    case "export":
      return {
        action: { type: "export", format: cmd.format },
        notice: `Exporting as ${cmd.format}…`,
        ok: true,
      };
    case "mode": {
      if (!cmd.value) {
        return { action: { type: "none" }, notice: `mode: ${ctx.mode}`, ok: true };
      }
      const next = cmd.value.toLowerCase();
      if (!isMode(next)) {
        return {
          action: { type: "none" },
          notice: `Unknown mode "${cmd.value}" (expected: ${SIDEBAR_MODES.join(", ")})`,
          ok: false,
        };
      }
      return { action: { type: "setMode", mode: next }, notice: `mode: ${next}`, ok: true };
    }
    case "model": {
      if (!cmd.value) {
        return { action: { type: "none" }, notice: `model: ${ctx.model || "(unset)"}`, ok: true };
      }
      return { action: { type: "setModel", model: cmd.value }, notice: `model: ${cmd.value}`, ok: true };
    }
    case "settings":
      return { action: { type: "openSettings" }, notice: "Opening settings…", ok: true };
    case "unknown":
      return {
        action: { type: "none" },
        notice: `Unknown command "/${cmd.name}" (try /help)`,
        ok: false,
      };
  }
}

function isMode(v: string): v is Mode {
  return (SIDEBAR_MODES as readonly string[]).includes(v);
}
