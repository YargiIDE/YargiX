/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Token totals for one CLI run (or one REPL turn).
 *
 * Providers emit a `usage` event per step. The editor Usage page sums those
 * events, so the CLI does the same — a single number a script can grep.
 */

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  events: number;
}

export function emptyUsage(): RunUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, events: 0 };
}

export function addUsage(
  acc: RunUsage,
  ev: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
): RunUsage {
  const prompt = clampCount(ev.promptTokens);
  const completion = clampCount(ev.completionTokens);
  const reported = clampCount(ev.totalTokens);
  acc.promptTokens += prompt;
  acc.completionTokens += completion;
  acc.totalTokens += reported > 0 ? reported : prompt + completion;
  acc.events += 1;
  return acc;
}

/** One line for stderr, or undefined when the provider sent no usage at all. */
export function formatUsage(acc: RunUsage): string | undefined {
  if (!acc.events) return undefined;
  return `- tokens: ${acc.promptTokens} in / ${acc.completionTokens} out (${acc.totalTokens} total)`;
}

function clampCount(n: number | undefined): number {
  if (n == null || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
