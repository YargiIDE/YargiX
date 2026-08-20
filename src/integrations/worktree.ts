/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Ephemeral git worktrees ("shadow workspaces").
 *
 * Risky or speculative work runs in a throwaway checkout on its own branch, so
 * the main tree is never touched until the user deliberately merges. Worktrees
 * share the repo's object store, so creating one is cheap (no re-clone).
 */

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { getWorkspaceRoot } from "../context/workspaceUtils";
import { logError } from "../logging";

const BRANCH_PREFIX = "yargix/";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().slice(0, 500)));
      else resolve(stdout);
    });
  });
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"], root);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export interface WorktreeInfo {
  /** Absolute path of the checkout. */
  dir: string;
  /** Branch name, e.g. "yargix/try-refactor". */
  branch: string;
}

/** Parse `git worktree list --porcelain` into the YargiX-created worktrees. */
function parseWorktrees(porcelain: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let dir = "";
  for (const raw of porcelain.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) {
      const branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      if (dir && branch.startsWith(BRANCH_PREFIX)) out.push({ dir, branch });
      dir = "";
    }
  }
  return out;
}

export async function listWorktrees(root = getWorkspaceRoot()): Promise<WorktreeInfo[]> {
  if (!(await isGitRepo(root))) return [];
  try {
    return parseWorktrees(await git(["worktree", "list", "--porcelain"], root));
  } catch (error) {
    logError("worktree.list", error);
    return [];
  }
}

/** Create a worktree on a fresh branch off the current HEAD. */
export async function createWorktree(name: string, root = getWorkspaceRoot()): Promise<WorktreeInfo> {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  const branch = `${BRANCH_PREFIX}${slug}-${Date.now().toString(36)}`;
  const dir = path.join(os.tmpdir(), "yargix-worktrees", `${slug}-${Date.now().toString(36)}`);
  await git(["worktree", "add", "-b", branch, dir, "HEAD"], root);
  return { dir, branch };
}

/** Remove a worktree and delete its branch. */
export async function removeWorktree(wt: WorktreeInfo, root = getWorkspaceRoot()): Promise<void> {
  await git(["worktree", "remove", "--force", wt.dir], root);
  try {
    await git(["branch", "-D", wt.branch], root);
  } catch {
    // Branch already gone or checked out elsewhere — the worktree is what matters.
  }
}

async function pickWorktree(root: string, placeHolder: string): Promise<WorktreeInfo | undefined> {
  const list = await listWorktrees(root);
  if (!list.length) {
    vscode.window.showInformationMessage("YargiX: no worktrees yet.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((w) => ({ label: w.branch, description: w.dir, wt: w })),
    { placeHolder },
  );
  return picked?.wt;
}

/** Register the worktree commands. */
export function registerWorktrees(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("yargix.worktree.create", async () => {
      const root = getWorkspaceRoot();
      if (!(await isGitRepo(root))) {
        vscode.window.showErrorMessage("YargiX: worktrees need a git repository.");
        return;
      }
      const name = await vscode.window.showInputBox({
        title: "YargiX — New worktree",
        prompt: "Name for the throwaway branch",
        placeHolder: "try-refactor",
        ignoreFocusOut: true,
      });
      if (!name?.trim()) return;
      try {
        const wt = await createWorktree(name, root);
        const open = await vscode.window.showInformationMessage(
          `YargiX: created ${wt.branch}`,
          "Open in new window",
        );
        if (open) {
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wt.dir), true);
        }
      } catch (error) {
        logError("worktree.create", error);
        vscode.window.showErrorMessage(`YargiX: could not create worktree — ${error instanceof Error ? error.message : String(error)}`);
      }
    }),

    vscode.commands.registerCommand("yargix.worktree.open", async () => {
      const root = getWorkspaceRoot();
      const wt = await pickWorktree(root, "Open which worktree?");
      if (wt) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wt.dir), true);
    }),

    vscode.commands.registerCommand("yargix.worktree.merge", async () => {
      const root = getWorkspaceRoot();
      const wt = await pickWorktree(root, "Merge which worktree into the current branch?");
      if (!wt) return;
      const ok = await vscode.window.showWarningMessage(
        `Merge ${wt.branch} into the current branch?`,
        { modal: true },
        "Merge",
      );
      if (ok !== "Merge") return;
      try {
        await git(["merge", "--no-ff", wt.branch], root);
        vscode.window.showInformationMessage(`YargiX: merged ${wt.branch}.`);
      } catch (error) {
        logError("worktree.merge", error);
        vscode.window.showErrorMessage(`YargiX: merge failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    }),

    vscode.commands.registerCommand("yargix.worktree.discard", async () => {
      const root = getWorkspaceRoot();
      const wt = await pickWorktree(root, "Discard which worktree?");
      if (!wt) return;
      const ok = await vscode.window.showWarningMessage(
        `Delete worktree ${wt.branch} and all its uncommitted work?`,
        { modal: true },
        "Discard",
      );
      if (ok !== "Discard") return;
      try {
        await removeWorktree(wt, root);
        vscode.window.showInformationMessage(`YargiX: discarded ${wt.branch}.`);
      } catch (error) {
        logError("worktree.discard", error);
        vscode.window.showErrorMessage(`YargiX: could not discard — ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}
