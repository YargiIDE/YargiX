/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Step } from "./types";

/**
 * Context helpers for the agent loop.
 *
 * Tool results and edit args stay verbatim for the full run. History is only
 * reduced by auto-summarization (when the window is nearly full) or by
 * `fitStepsToBudget` dropping whole call groups as a last resort. Thinking is
 * UI-only and is stripped before the model wire.
 */

/** Edit / durable tools — preferred when budget-fitting must drop groups. */
const PROTECTED_RESULTS = new Set([
  "TodoWrite",
  "TodoRead",
  "Task",
  "AskQuestion",
  "SwitchMode",
  "WritePlan",
  "StrReplace",
  "Write",
  "Delete",
  "EditNotebook",
]);

/** Edit payloads — same protection class for budget selection. */
const SLIM_ARGS = new Set(["StrReplace", "Write", "EditNotebook", "Delete"]);

/** A rendered image costs far more than its base64 length suggests. */
const IMAGE_TOKENS = 1300;

/** Rough token estimate (~4 chars/token) for one step, images priced realistically. */
export function stepTokens(s: Step): number {
  let chars = 0;
  if (s.kind === "user") {
    chars += s.text.length;
    for (const a of s.attachments || []) chars += a.kind === "image" ? 0 : a.data?.length || 0;
    const imgs = (s.attachments || []).filter((a) => a.kind === "image").length;
    return Math.ceil(chars / 4) + imgs * IMAGE_TOKENS + 4;
  }
  if (s.kind === "assistant") {
    // thinking is UI-only — never sent on the wire (see buildMessages).
    chars += s.text?.length || 0;
    for (const c of s.calls || []) chars += (c.arguments?.length || 0) + (c.name?.length || 0) + 8;
    return Math.ceil(chars / 4) + 4;
  }
  chars += s.output?.length || 0;
  return Math.ceil(chars / 4) + (s.image ? IMAGE_TOKENS : 0) + 4;
}

/** Total rough token estimate for a step list. */
export function stepsTokens(steps: Step[]): number {
  return steps.reduce((n, s) => n + stepTokens(s), 0);
}

function lastUserIndex(steps: Step[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user") return i;
  }
  return 0;
}

/** Index of the last real (non-synthetic) user message — the actual request. */
export function lastRealUserIndex(steps: Step[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "user" && !s.synthetic) return i;
  }
  return lastUserIndex(steps);
}

/** The user's current request text, used to anchor the durable state block. */
export function currentRequestText(steps: Step[]): string {
  const i = lastRealUserIndex(steps);
  const s = steps[i];
  return s && s.kind === "user" ? s.text : "";
}

/**
 * Start of a recent-token window (newest-first). Used by compaction splits;
 * no longer used to decide what to prune — pruning is gone.
 */
export function recentWindowStart(steps: Step[], keepTokens: number): number {
  let used = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    used += stepTokens(steps[i]);
    if (used > keepTokens) return i + 1;
  }
  return 0;
}

/** Strip UI-only thinking from the model wire copy. Never mutates tool bodies or args. */
function stripThinking(steps: Step[]): void {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.thinking) {
      steps[i] = { ...s, thinking: undefined };
    }
  }
}

/**
 * Prepare history for the model wire. Content stays full — no stubs, no
 * supersede marks, no slimmed edit args. Only thinking is dropped (UI-only).
 */
export function economizeHistory(steps: Step[], _opts?: { keepRecentTokens?: number }): { prunedResults: number; slimmedCalls: number } {
  stripThinking(steps);
  return { prunedResults: 0, slimmedCalls: 0 };
}

/**
 * Budget-fit prep. Formerly hard-pruned dumps; now a no-op on content so
 * `fitStepsToBudget` can drop whole groups with full fidelity still intact.
 */
export function economizeHistoryHard(steps: Step[], _opts?: { keepRecentTokens?: number }): void {
  stripThinking(steps);
}

/** True if a step is durable task state that budget-trim must prefer to keep. */
export function isProtectedStep(s: Step): boolean {
  if (s.kind === "user") return true;
  if (s.kind === "assistant") {
    if ((s.text || "").trim()) return true;
    return (s.calls || []).some((c) => PROTECTED_RESULTS.has(c.name) || SLIM_ARGS.has(c.name));
  }
  return PROTECTED_RESULTS.has(s.name);
}

/** Hard safety trigger. Normal compaction waits for a semantic boundary. */
export const COMPACT_AT_FILL = 0.92;

/** Soft boundary trigger — wait until the window is nearly full. */
export const COMPACT_SOFT_FILL = 0.85;

/**
 * After summarize, keep this fraction of budget as verbatim tail. Higher =
 * more recent tool results survive compaction intact.
 */
export const COMPACT_KEEP_FRAC = 0.55;

/** Skip compaction unless the summarized prefix frees at least this much budget. */
export const COMPACT_MIN_GAIN_FRAC = 0.15;

/** Minimum steps between two compactions, so a run can't summarize in a loop. */
export const COMPACT_COOLDOWN_STEPS = 8;

/** Safe boundary: the model just completed a subtask instead of being mid-tool loop. */
export function isCompactionBoundary(steps: Step[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "assistant" && !!last.text.trim() && !last.calls.length) return true;
  // Loop-injected messages (subagent reports, nudges) land between turns, which
  // is exactly a safe place to compact.
  if (last.kind === "user") return last.synthetic === true;
  return false;
}
