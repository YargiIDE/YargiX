/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Markdown transcripts for a conversation.
 *
 * Shared by the CLI `/export` path and the editor sidebar so a saved chat
 * looks the same in both places. Tool dumps are clipped — a 2 MB Read result
 * must not become a 2 MB markdown file.
 */

import type { Step } from "../agent/types";

export const TOOL_OUTPUT_CLIP = 8_000;

export type TranscriptFormat = "json" | "markdown";

export interface ConversationTranscript {
  title: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  personaId?: string;
}

/** Body of a transcript: speakers, tool calls, clipped results. */
export function stepsToMarkdown(steps: Step[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.kind === "user") {
      if (step.synthetic) continue;
      lines.push("## User", "", step.text, "");
      if (step.attachments?.length) {
        lines.push(`_Attachments: ${step.attachments.map((a) => a.name).join(", ")}_`, "");
      }
    } else if (step.kind === "assistant") {
      if (step.text.trim()) lines.push("## Assistant", "", step.text, "");
      for (const call of step.calls) {
        lines.push(`### ${call.name}`, "", "```", call.arguments, "```", "");
      }
    } else {
      lines.push(`### ${step.name} (${step.status})`, "", "```", clip(step.output, TOOL_OUTPUT_CLIP), "```", "");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Editor conversation → readable markdown (no attachment blobs). */
export function conversationToMarkdown(conv: ConversationTranscript, now = Date.now()): string {
  const title = conv.title.trim() || "YargiX conversation";
  const header = [
    `# ${title}`,
    "",
    `- exported: ${new Date(now).toISOString()}`,
    `- created: ${new Date(conv.createdAt).toISOString()}`,
    `- updated: ${new Date(conv.updatedAt).toISOString()}`,
  ];
  if (conv.personaId) header.push(`- persona: ${conv.personaId}`);
  header.push("");
  return `${header.join("\n")}\n${stepsToMarkdown(conv.steps)}`;
}

/**
 * Decide JSON vs markdown from the path the user picked, falling back to the
 * requested format. A `.json` save must never emit markdown (and vice versa).
 */
export function resolveTranscriptFormat(filePath: string, requested?: TranscriptFormat): TranscriptFormat {
  const lower = filePath.trim().toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return requested ?? "markdown";
}

export function parseExportFormat(value: string): TranscriptFormat | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "json" || v.endsWith(".json")) return "json";
  if (v === "md" || v === "markdown" || v.endsWith(".md") || v.endsWith(".markdown")) return "markdown";
  return undefined;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more bytes)`;
}
