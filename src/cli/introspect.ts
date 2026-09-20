/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * One-shot CLI introspection: list modes, list tools, preview a prompt.
 *
 * These paths never touch the network and never need credentials, so a CI job
 * can validate `--mode` names, check tool availability, or verify that
 * `--file` / `--stdin` resolves to the intended prompt without spending a
 * model call. Everything here is pure formatting over data the caller already
 * has; the exit-early wiring lives in `main.ts`.
 */

import type { Mode } from "../agent/types";
import { MODES } from "./args";
import type { PromptSource } from "./io";

/** One-line identity of a mode, matching the README mode table. */
export interface ModeInfo {
  mode: Mode;
  /** Short human description (ASCII only — see main.ts `describe`). */
  description: string;
  /** True when the mode itself can edit files. Coordinators edit via delegates. */
  canEdit: boolean;
}

export const MODE_INFO: Record<Mode, { description: string; canEdit: boolean }> = {
  agent: { description: "Does the work: reads, edits, runs commands", canEdit: true },
  ask: { description: "Answers questions about the codebase", canEdit: false },
  plan: { description: "Writes a plan and asks for approval before implementing", canEdit: false },
  debug: { description: "Hypothesis, evidence, minimal fix, verify", canEdit: true },
  review: { description: "Defect-first code review with severities", canEdit: false },
  multitask: { description: "Coordinates parallel subagents (edits only via delegates)", canEdit: false },
  project: { description: "Team lead running specialist subagents (edits only via delegates)", canEdit: false },
};

/** Everything `formatTools` needs, without importing the tool registry. */
export interface ToolSummary {
  name: string;
  description: string;
  mutating: boolean;
}

/** First non-blank line of `text`, trimmed and capped so a list stays one tool per line. */
export function firstLine(text: string, max = 80): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim().replace(/\s+/g, " "))
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** Human-readable mode list, one mode per line with its edit marker. */
export function formatModes(): string {
  const width = Math.max(...MODES.map((m) => m.length));
  const lines = MODES.map((mode) => {
    const info = MODE_INFO[mode];
    const marker = info.canEdit ? "(edits)" : "(read-only)";
    return `${mode.padEnd(width)}  ${info.description} ${marker}`;
  });
  return `${lines.join("\n")}\n`;
}

/** Bare mode names, one per line, for scripts (`--quiet`). */
export function formatModeNames(): string {
  return `${MODES.join("\n")}\n`;
}

/** JSON counterpart of `formatModes`, in `MODES` order. */
export function modesJson(): ModeInfo[] {
  return MODES.map((mode) => ({ mode, ...MODE_INFO[mode] }));
}

/** Human-readable tool list for one mode. A `*` marks workspace-changing tools. */
export function formatTools(mode: Mode, tools: ToolSummary[]): string {
  const header = `Tools for mode "${mode}" (${tools.length}):`;
  if (!tools.length) return `${header}\n  (none)\n`;
  const width = Math.max(...tools.map((t) => t.name.length));
  const lines = tools.map((t) => `  ${t.name.padEnd(width)}${t.mutating ? " *" : "  "} ${firstLine(t.description)}`);
  return `${header}\n${lines.join("\n")}\n  (* = can change the workspace)\n`;
}

/** Bare tool names, one per line, for scripts (`--quiet`). */
export function formatToolNames(tools: ToolSummary[]): string {
  return tools.length ? `${tools.map((t) => t.name).join("\n")}\n` : "(none)\n";
}

/** JSON counterpart of `formatTools`; descriptions stay whole for machines. */
export function toolsJson(mode: Mode, tools: ToolSummary[]): { mode: Mode; count: number; tools: ToolSummary[] } {
  return { mode, count: tools.length, tools: tools.map((t) => ({ ...t })) };
}

/** What `--print-prompt` reports: the resolved prompt plus the run it would start. */
export interface PromptPreview {
  mode: Mode;
  /** Empty when no model is configured — a dry run does not require one. */
  model: string;
  cwd: string;
  /** Empty when no extra instructions were passed. */
  system: string;
  /** Where the prompt text came from. */
  source: string;
  prompt: string;
}

/** Short label for a resolved prompt source. */
export function describePromptSource(source: PromptSource): string {
  switch (source.kind) {
    case "text":
      return "argv";
    case "file":
      return `file ${source.path}`;
    case "stdin":
      return "stdin";
    case "none":
      return "none";
    default: {
      const unhandled: never = source;
      return unhandled;
    }
  }
}

/** Human-readable dry-run report: the run header, then the prompt verbatim. */
export function formatPromptPreview(preview: PromptPreview): string {
  const lines = [
    `mode: ${preview.mode}`,
    `model: ${preview.model || "(unset)"}`,
    `cwd: ${preview.cwd}`,
    `system: ${preview.system || "(none)"}`,
    `source: ${preview.source}`,
    "--- prompt ---",
    preview.prompt,
  ];
  return `${lines.join("\n")}\n`;
}
