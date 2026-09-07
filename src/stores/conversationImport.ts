/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Trust boundary for conversation files opened in the editor.
 *
 * Accepts a CLI `/save` snapshot or a sidebar JSON export. Unknown kinds,
 * missing fields, and oversized dumps are rejected instead of being fed into
 * the agent loop. A successful parse always produces a *new* conversation —
 * the file's id is never reused, so two imports cannot collide.
 */

import type { Attachment, Step } from "../agent/types";
import { MAX_SESSION_STEPS, parseSession, parseSteps } from "../cli/session";
import type { AssistantBlock, Turn } from "../shared/turns";

/** Hard cap so a multi-GB dump cannot fill the extension host. */
export const MAX_IMPORT_CHARS = 5_000_000;

export interface ImportedConversation {
  title: string;
  steps: Step[];
  turns: Turn[];
  personaId?: string;
  usedTokens?: number;
  createdAt: number;
  source: "session" | "conversation";
}

export function parseImportedConversation(raw: string): { imported: ImportedConversation } | { error: string } {
  if (raw.length > MAX_IMPORT_CHARS) {
    return { error: `file is too large (max ${MAX_IMPORT_CHARS} characters)` };
  }
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) return { error: "file is empty" };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "file is not valid JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "file must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== undefined) {
    const parsed = parseSession(text);
    if ("error" in parsed) return parsed;
    if (parsed.snapshot.steps.length === 0) return { error: "session has no conversation to import" };
    return {
      imported: {
        title: titleFromSteps(parsed.snapshot.steps),
        steps: parsed.snapshot.steps,
        turns: turnsFromSteps(parsed.snapshot.steps),
        createdAt: parsed.snapshot.savedAt,
        source: "session",
      },
    };
  }

  const parsed = parseSteps(obj.steps);
  if ("error" in parsed) return parsed;
  if (parsed.steps.length === 0) return { error: "conversation has no messages to import" };

  const turns = parseTurns(obj.turns) ?? turnsFromSteps(parsed.steps);
  const title = sanitizeTitle(obj.title) || titleFromSteps(parsed.steps);
  const personaId = typeof obj.personaId === "string" && obj.personaId.trim() && obj.personaId.length <= 64
    ? obj.personaId.trim()
    : undefined;
  const usedTokens = typeof obj.usedTokens === "number" && Number.isFinite(obj.usedTokens) && obj.usedTokens >= 0 && obj.usedTokens <= 1e9
    ? Math.floor(obj.usedTokens)
    : undefined;
  const createdAt = typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt) && obj.createdAt > 0
    ? obj.createdAt
    : Date.now();

  return {
    imported: {
      title,
      steps: parsed.steps,
      turns,
      personaId,
      usedTokens,
      createdAt,
      source: "conversation",
    },
  };
}

/** Rebuild chat bubbles from model-history steps when the file has no turns. */
export function turnsFromSteps(steps: Step[]): Turn[] {
  const turns: Turn[] = [];
  const tools = new Map<string, { turn: number; block: number }>();

  for (const step of steps) {
    if (step.kind === "user") {
      if (step.synthetic) continue;
      const turn: Turn = { role: "user", text: step.text };
      if (step.attachments?.length) turn.attachments = step.attachments;
      turns.push(turn);
      continue;
    }
    if (step.kind === "assistant") {
      const blocks: AssistantBlock[] = [];
      if (step.thinking?.trim()) {
        blocks.push({ kind: "thinking", text: step.thinking, endedAt: 1 });
      }
      if (step.text) blocks.push({ kind: "text", text: step.text });
      for (const call of step.calls) {
        blocks.push({
          kind: "tool",
          callId: call.id,
          name: call.name,
          input: parseToolInput(call.arguments),
          status: "running",
        });
        tools.set(call.id, { turn: turns.length, block: blocks.length - 1 });
      }
      if (blocks.length) turns.push({ role: "assistant", blocks });
      continue;
    }
    const loc = tools.get(step.callId);
    if (!loc) continue;
    const turn = turns[loc.turn];
    if (!turn || turn.role !== "assistant") continue;
    const block = turn.blocks[loc.block];
    if (!block || block.kind !== "tool") continue;
    turn.blocks[loc.block] = { ...block, status: step.status, result: step.output };
  }
  return turns;
}

function parseToolInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function titleFromSteps(steps: Step[]): string {
  for (const s of steps) {
    if (s.kind === "user" && !s.synthetic && s.text.trim()) {
      const t = s.text.trim().replace(/\s+/g, " ");
      return t.length > 40 ? `${t.slice(0, 40)}…` : t;
    }
  }
  return "Imported chat";
}

function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, 80);
}

function parseTurns(raw: unknown): Turn[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_SESSION_STEPS) return undefined;
  const out: Turn[] = [];
  for (const item of raw) {
    const turn = parseTurn(item);
    if (!turn) return undefined;
    out.push(turn);
  }
  return out;
}

function parseTurn(raw: unknown): Turn | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  if (t.role === "user") {
    if (typeof t.text !== "string") return undefined;
    const turn: Turn = { role: "user", text: t.text };
    const attachments = parseTurnAttachments(t.attachments);
    if (attachments.length) turn.attachments = attachments;
    if (typeof t.model === "string") turn.model = t.model;
    if (typeof t.mode === "string") turn.mode = t.mode;
    return turn;
  }
  if (t.role === "assistant") {
    if (!Array.isArray(t.blocks)) return undefined;
    const blocks: AssistantBlock[] = [];
    for (const b of t.blocks) {
      const block = parseBlock(b);
      if (!block) return undefined;
      blocks.push(block);
    }
    return { role: "assistant", blocks };
  }
  return undefined;
}

function parseBlock(raw: unknown): AssistantBlock | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  if (b.kind === "text") {
    return typeof b.text === "string" ? { kind: "text", text: b.text } : undefined;
  }
  if (b.kind === "thinking") {
    if (typeof b.text !== "string") return undefined;
    const block: AssistantBlock = { kind: "thinking", text: b.text };
    if (typeof b.startedAt === "number") block.startedAt = b.startedAt;
    if (typeof b.endedAt === "number") block.endedAt = b.endedAt;
    return block;
  }
  if (b.kind === "tool") {
    if (typeof b.callId !== "string" || typeof b.name !== "string") return undefined;
    if (b.status !== "running" && b.status !== "completed" && b.status !== "error") return undefined;
    const block: AssistantBlock = {
      kind: "tool",
      callId: b.callId,
      name: b.name,
      input: b.input,
      status: b.status,
    };
    if (typeof b.result === "string") block.result = b.result;
    if (typeof b.diff === "string") block.diff = b.diff;
    return block;
  }
  if (b.kind === "error") {
    return typeof b.message === "string" ? { kind: "error", message: b.message } : undefined;
  }
  if (b.kind === "compaction") {
    if (b.status !== "running" && b.status !== "done" && b.status !== "failed") return undefined;
    const block: AssistantBlock = { kind: "compaction", status: b.status };
    if (typeof b.summary === "string") block.summary = b.summary;
    return block;
  }
  if (b.kind === "max-steps") {
    return typeof b.steps === "number" ? { kind: "max-steps", steps: b.steps } : undefined;
  }
  return undefined;
}

function parseTurnAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const att = a as Record<string, unknown>;
    if (
      typeof att.id === "string" &&
      typeof att.name === "string" &&
      typeof att.mime === "string" &&
      typeof att.data === "string" &&
      (att.kind === "image" || att.kind === "text")
    ) {
      out.push({ id: att.id, name: att.name, mime: att.mime, data: att.data, kind: att.kind });
    }
  }
  return out;
}
