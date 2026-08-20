/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The memory bank: durable project knowledge that survives sessions.
 *
 * Chat history is disposable — it gets summarised and eventually dropped. This
 * is the opposite: a small set of Markdown notes under `.yargix/memory/` that
 * the agent maintains and that is injected into every run, so hard-won facts
 * (how the build works, why a module is shaped that way, the trap that wasted
 * an hour last week) are never rediscovered from scratch.
 *
 * It lives in the workspace, so it is committable and shared with the team.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getWorkspaceRoot } from "./workspaceUtils";

export const MEMORY_DIR = path.join(".yargix", "memory");
/** Per-note cap. A note that outgrows this should be split by topic. */
export const MAX_NOTE_BYTES = 16_000;
/** Total injected into the prompt. Memory must never crowd out the real work. */
export const MAX_PROMPT_BYTES = 12_000;

export interface MemoryNote {
  /** File name without the .md extension. */
  name: string;
  /** Workspace-relative path. */
  path: string;
  bytes: number;
}

/**
 * Reduce a caller-supplied name to a safe, flat file name.
 *
 * The model chooses these names, so this is a trust boundary: anything that
 * could escape the memory directory (separators, `..`, drive letters, absolute
 * paths, NUL) has to be stripped rather than escaped.
 */
export function safeMemoryName(raw: string): string {
  const base = String(raw ?? "")
    .replace(/\.md$/i, "")
    // Separators, traversal segments and anything exotic collapse to a hyphen,
    // so "../../etc/passwd" can only ever become "etc-passwd".
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    // A name may never start or end with a dot or hyphen: no "..", no dotfiles.
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 64)
    .toLowerCase();
  return base || "notes";
}

function dirFor(root = getWorkspaceRoot()): string {
  return path.join(root, MEMORY_DIR);
}

function fileFor(name: string, root = getWorkspaceRoot()): string {
  return path.join(dirFor(root), `${safeMemoryName(name)}.md`);
}

/** Every note in the bank, alphabetical. */
export async function listMemories(root = getWorkspaceRoot()): Promise<MemoryNote[]> {
  const dir = dirFor(root);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // no memory bank yet
  }
  const out: MemoryNote[] = [];
  for (const file of entries.sort()) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    try {
      const stat = await fs.stat(path.join(dir, file));
      if (!stat.isFile()) continue;
      out.push({
        name: file.replace(/\.md$/i, ""),
        path: path.join(MEMORY_DIR, file).replace(/\\/g, "/"),
        bytes: stat.size,
      });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

export async function readMemory(name: string, root = getWorkspaceRoot()): Promise<string | undefined> {
  try {
    return await fs.readFile(fileFor(name, root), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeMemory(name: string, content: string, root = getWorkspaceRoot()): Promise<MemoryNote> {
  const body = String(content ?? "").slice(0, MAX_NOTE_BYTES).trimEnd();
  const file = fileFor(name, root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${body}\n`, "utf8");
  return {
    name: safeMemoryName(name),
    path: path.join(MEMORY_DIR, `${safeMemoryName(name)}.md`).replace(/\\/g, "/"),
    bytes: Buffer.byteLength(body) + 1,
  };
}

export async function appendMemory(name: string, content: string, root = getWorkspaceRoot()): Promise<MemoryNote> {
  const existing = (await readMemory(name, root)) ?? "";
  const joined = existing.trimEnd() ? `${existing.trimEnd()}\n\n${String(content ?? "").trim()}` : String(content ?? "").trim();
  return writeMemory(name, joined, root);
}

export async function deleteMemory(name: string, root = getWorkspaceRoot()): Promise<boolean> {
  try {
    await fs.rm(fileFor(name, root));
    return true;
  } catch {
    return false;
  }
}

/**
 * Assemble the notes into one prompt block, newest-relevant first and bounded.
 * Truncation is per note so one long note cannot hide all the others.
 */
export async function memoryForPrompt(root = getWorkspaceRoot()): Promise<string> {
  const notes = await listMemories(root);
  if (!notes.length) return "";

  const share = Math.max(600, Math.floor(MAX_PROMPT_BYTES / notes.length));
  const blocks: string[] = [];
  let used = 0;
  for (const note of notes) {
    if (used >= MAX_PROMPT_BYTES) break;
    const body = (await readMemory(note.name, root))?.trim();
    if (!body) continue;
    const room = Math.min(share, MAX_PROMPT_BYTES - used);
    const text = body.length > room ? `${body.slice(0, room)}\n…[truncated — read ${note.path} for the rest]` : body;
    used += text.length;
    blocks.push(`<memory name="${note.name}" path="${note.path}">\n${text}\n</memory>`);
  }
  return blocks.join("\n\n");
}
