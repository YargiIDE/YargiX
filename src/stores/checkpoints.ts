/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Checkpoints: rewind the workspace to how it looked before a run.
 *
 * Per-hunk Keep/Undo covers one file at a time; this covers the other failure
 * mode — an agent that edited twenty files and made things worse. Snapshots are
 * taken lazily: the first time a file is written during a run, its previous
 * contents are stashed. Untouched files cost nothing, so a checkpoint is cheap
 * even in a huge repo.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { safePath } from "../context/workspaceUtils";
import { logError } from "../logging";

/** A file as it looked when the checkpoint was taken. `null` = did not exist. */
export interface CheckpointFile {
  path: string;
  content: string | null;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
  /** Conversation that produced it, when it came from an agent run. */
  convId?: string;
  files: CheckpointFile[];
}

/** How many checkpoints to keep (oldest pruned first). */
export const MAX_CHECKPOINTS = 20;
/** Files larger than this are not stashed; restoring cannot undo them. */
export const MAX_FILE_BYTES = 2_000_000;

// ---------------------------------------------------------------- pure core

/**
 * Record a file's pre-edit contents, first write wins.
 *
 * Later edits in the same run must NOT overwrite the entry: the checkpoint has
 * to hold the state from before the run started, not before the latest edit.
 */
export function captureInto(files: CheckpointFile[], path: string, content: string | null): CheckpointFile[] {
  if (files.some((f) => f.path === path)) return files;
  if (content !== null && content.length > MAX_FILE_BYTES) return files;
  return [...files, { path, content }];
}

/** Keep only the newest `max` checkpoints. */
export function prune(list: Checkpoint[], max = MAX_CHECKPOINTS): Checkpoint[] {
  return list.length <= max ? list : list.slice(list.length - max);
}

/** Short human summary of what a checkpoint would restore. */
export function describe(cp: Checkpoint): string {
  const created = cp.files.filter((f) => f.content === null).length;
  const changed = cp.files.length - created;
  const parts: string[] = [];
  if (changed) parts.push(`${changed} file${changed === 1 ? "" : "s"} restored`);
  if (created) parts.push(`${created} created file${created === 1 ? "" : "s"} removed`);
  return parts.join(", ") || "nothing to undo";
}

// ---------------------------------------------------------------- the store

type Listener = () => void;

class CheckpointStore {
  private list: Checkpoint[] = [];
  private active: Checkpoint | undefined;
  private storageFile: string | undefined;
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | undefined;

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of [...this.listeners]) fn();
    this.scheduleSave();
  }

  /** Point the store at globalStorage and load anything already saved. */
  async init(storageDir: string): Promise<void> {
    this.storageFile = path.join(storageDir, "checkpoints.json");
    try {
      const raw = await fs.readFile(this.storageFile, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.list = prune(parsed as Checkpoint[]);
    } catch {
      // No checkpoints yet (or unreadable) — start empty.
    }
  }

  private scheduleSave() {
    if (!this.storageFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 500);
  }

  private async save(): Promise<void> {
    if (!this.storageFile) return;
    try {
      await fs.mkdir(path.dirname(this.storageFile), { recursive: true });
      await fs.writeFile(this.storageFile, JSON.stringify(this.list), "utf8");
    } catch (error) {
      logError("checkpoints.save", error);
    }
  }

  /**
   * Open a new checkpoint. The previous one is sealed; an empty one is dropped
   * so runs that changed nothing leave no entry behind.
   */
  begin(label: string, convId?: string): void {
    if (this.active && !this.active.files.length) {
      this.list = this.list.filter((c) => c.id !== this.active!.id);
    }
    const cp: Checkpoint = {
      id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label,
      createdAt: Date.now(),
      convId,
      files: [],
    };
    this.active = cp;
    this.list = prune([...this.list, cp]);
  }

  /** Stash a file's pre-edit state into the open checkpoint. */
  capture(relPath: string, before: string, existedBefore: boolean): void {
    if (!this.active) this.begin("Edits");
    const cp = this.active!;
    const next = captureInto(cp.files, relPath, existedBefore ? before : null);
    if (next !== cp.files) {
      cp.files = next;
      this.emit();
    }
  }

  all(): Checkpoint[] {
    // Newest first, and never offer an empty checkpoint to restore.
    return [...this.list].filter((c) => c.files.length).reverse();
  }
  get(id: string): Checkpoint | undefined {
    return this.list.find((c) => c.id === id);
  }
  count(): number {
    return this.all().length;
  }

  /**
   * Roll the workspace back to a checkpoint. The current state is captured
   * first, so an unwanted restore can itself be undone.
   */
  async restore(id: string): Promise<{ restored: number; failed: string[] }> {
    const cp = this.get(id);
    if (!cp) return { restored: 0, failed: [] };

    // Snapshot "now" before overwriting anything.
    this.begin(`Before restoring “${cp.label}”`, cp.convId);
    for (const f of cp.files) {
      try {
        const abs = safePath(f.path);
        let current: string | null = null;
        try {
          current = await fs.readFile(abs, "utf8");
        } catch {
          current = null; // file is gone right now
        }
        this.capture(f.path, current ?? "", current !== null);
      } catch {
        // Unresolvable path — nothing to snapshot.
      }
    }

    let restored = 0;
    const failed: string[] = [];
    for (const f of cp.files) {
      try {
        const abs = safePath(f.path);
        if (f.content === null) {
          await fs.rm(abs, { force: true });
        } else {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, f.content, "utf8");
        }
        restored++;
      } catch (error) {
        logError("checkpoints.restore", error, { path: f.path });
        failed.push(f.path);
      }
    }
    this.emit();
    return { restored, failed };
  }

  /** Forget every checkpoint (and whatever they could have undone). */
  clear(): void {
    this.list = [];
    this.active = undefined;
    this.emit();
  }
}

export const checkpoints = new CheckpointStore();

/**
 * Called from the edit pipeline for every file write. Kept as a free function
 * so `pendingChanges` needs only this one import to feed the store.
 */
export function captureEdit(relPath: string, before: string, existedBefore: boolean): void {
  try {
    checkpoints.capture(relPath, before, existedBefore);
  } catch (error) {
    // Checkpointing must never break an edit.
    logError("checkpoints.capture", error, { path: relPath });
  }
}
