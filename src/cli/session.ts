/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Interactive-session snapshots.
 *
 * A saved session is a JSON document the user can commit, pipe, or reload.
 * Parsing never trusts the file: unknown kinds, missing fields, and oversized
 * histories are rejected instead of being fed back into the agent loop.
 */

import type { Attachment, Mode, Step, ToolCall, ToolImage } from "../agent/types";
import { stepsToMarkdown } from "../shared/transcript";
import { MODES } from "./args";

export const SESSION_VERSION = 1 as const;
export const DEFAULT_SESSION_JSON = ".yargix/session.json";
export const DEFAULT_SESSION_MD = ".yargix/session.md";
/** A hostile dump should not be able to blow the process heap on /load. */
export const MAX_SESSION_STEPS = 10_000;

export interface SessionSnapshot {
  version: typeof SESSION_VERSION;
  savedAt: number;
  mode: Mode;
  model: string;
  cwd: string;
  steps: Step[];
}

export function snapshotSession(opts: {
  mode: Mode;
  model: string;
  cwd: string;
  steps: Step[];
  now?: number;
}): SessionSnapshot {
  return {
    version: SESSION_VERSION,
    savedAt: opts.now ?? Date.now(),
    mode: opts.mode,
    model: opts.model,
    cwd: opts.cwd,
    steps: cloneJson(opts.steps),
  };
}

export function serializeSession(snap: SessionSnapshot): string {
  return `${JSON.stringify(snap, null, 2)}\n`;
}

export function parseSession(raw: string): { snapshot: SessionSnapshot } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "session file is not valid JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "session file must be an object" };
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== SESSION_VERSION) {
    return { error: `unsupported session version ${String(obj.version)}` };
  }
  if (!isMode(obj.mode)) return { error: `invalid mode in session: ${String(obj.mode)}` };
  if (typeof obj.model !== "string") return { error: "session is missing model" };
  if (typeof obj.cwd !== "string") return { error: "session is missing cwd" };
  if (typeof obj.savedAt !== "number" || !Number.isFinite(obj.savedAt)) {
    return { error: "session is missing savedAt" };
  }
  if (!Array.isArray(obj.steps)) return { error: "session steps must be an array" };
  if (obj.steps.length > MAX_SESSION_STEPS) {
    return { error: `session has too many steps (max ${MAX_SESSION_STEPS})` };
  }
  const steps: Step[] = [];
  for (let i = 0; i < obj.steps.length; i++) {
    const parsed = parseStep(obj.steps[i], i);
    if ("error" in parsed) return parsed;
    steps.push(parsed.step);
  }
  return {
    snapshot: {
      version: SESSION_VERSION,
      savedAt: obj.savedAt,
      mode: obj.mode,
      model: obj.model,
      cwd: obj.cwd,
      steps,
    },
  };
}

export function sessionToMarkdown(snap: SessionSnapshot): string {
  const header = [
    "# YargiX session",
    "",
    `- saved: ${new Date(snap.savedAt).toISOString()}`,
    `- mode: ${snap.mode}`,
    `- model: ${snap.model || "(unset)"}`,
    `- cwd: ${snap.cwd}`,
  ].join("\n");
  return `${header}\n\n${stepsToMarkdown(snap.steps)}`;
}

function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

function parseStep(raw: unknown, index: number): { step: Step } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `step ${index} is not an object` };
  }
  const s = raw as Record<string, unknown>;
  if (s.kind === "user") {
    if (typeof s.text !== "string") return { error: `step ${index} user text must be a string` };
    const step: Step = { kind: "user", text: s.text };
    if (s.synthetic === true) step.synthetic = true;
    const attachments = parseAttachments(s.attachments);
    if (attachments.length) step.attachments = attachments;
    return { step };
  }
  if (s.kind === "assistant") {
    if (typeof s.text !== "string") return { error: `step ${index} assistant text must be a string` };
    const calls: ToolCall[] = [];
    if (s.calls !== undefined) {
      if (!Array.isArray(s.calls)) return { error: `step ${index} assistant calls must be an array` };
      for (const c of s.calls) {
        const call = parseCall(c);
        if (!call) return { error: `step ${index} has a malformed tool call` };
        calls.push(call);
      }
    }
    const step: Step = { kind: "assistant", text: s.text, calls };
    if (typeof s.thinking === "string") step.thinking = s.thinking;
    return { step };
  }
  if (s.kind === "tool-result") {
    if (typeof s.callId !== "string" || typeof s.name !== "string" || typeof s.output !== "string") {
      return { error: `step ${index} tool-result is missing fields` };
    }
    if (s.status !== "completed" && s.status !== "error") {
      return { error: `step ${index} tool-result has an invalid status` };
    }
    const step: Step = {
      kind: "tool-result",
      callId: s.callId,
      name: s.name,
      output: s.output,
      status: s.status,
    };
    const image = parseImage(s.image);
    if (image) step.image = image;
    return { step };
  }
  return { error: `step ${index} has unknown kind ${String(s.kind)}` };
}

function parseCall(raw: unknown): ToolCall | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.name !== "string" || typeof c.arguments !== "string") return undefined;
  return { id: c.id, name: c.name, arguments: c.arguments };
}

function parseAttachments(raw: unknown): Attachment[] {
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

function parseImage(raw: unknown): ToolImage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const img = raw as Record<string, unknown>;
  if (typeof img.mime !== "string" || typeof img.base64 !== "string") return undefined;
  return { mime: img.mime, base64: img.base64 };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

