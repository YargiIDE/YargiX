/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Commands for rewinding the workspace to a checkpoint.
 *
 * Restoring overwrites files on disk, so every path here is explicit: the user
 * picks the checkpoint, sees exactly what it will change, and confirms in a
 * modal before anything is written.
 */

import * as vscode from "vscode";
import { checkpoints, describe, type Checkpoint } from "../stores/checkpoints";

/** "3 minutes ago" style stamp for the quick pick. */
function ago(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleString();
}

async function pickCheckpoint(placeHolder: string): Promise<Checkpoint | undefined> {
  const list = checkpoints.all();
  if (!list.length) {
    vscode.window.showInformationMessage("YargiX: no checkpoints yet — they are created when the agent edits files.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((cp) => ({
      label: cp.label,
      description: ago(cp.createdAt),
      detail: describe(cp),
      cp,
    })),
    { placeHolder, matchOnDetail: true },
  );
  return picked?.cp;
}

/** Register the checkpoint commands. */
export function registerCheckpointsUi(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("yargix.checkpoint.restore", async () => {
      const cp = await pickCheckpoint("Rewind the workspace to which checkpoint?");
      if (!cp) return;

      const ok = await vscode.window.showWarningMessage(
        `Rewind to “${cp.label}”?`,
        {
          modal: true,
          detail:
            `${describe(cp)}.\n\n` +
            "Files changed since then will be overwritten on disk. " +
            "A checkpoint of the current state is taken first, so this can itself be undone.",
        },
        "Rewind",
      );
      if (ok !== "Rewind") return;

      const { restored, failed } = await checkpoints.restore(cp.id);
      if (failed.length) {
        vscode.window.showWarningMessage(
          `YargiX: rewound ${restored} file(s); ${failed.length} could not be written (${failed.slice(0, 3).join(", ")}).`,
        );
      } else {
        vscode.window.showInformationMessage(`YargiX: rewound ${restored} file(s) to “${cp.label}”.`);
      }
    }),

    vscode.commands.registerCommand("yargix.checkpoint.create", async () => {
      const label = await vscode.window.showInputBox({
        title: "YargiX — New checkpoint",
        prompt: "Name this point in time",
        placeHolder: "before the big refactor",
        ignoreFocusOut: true,
      });
      if (!label?.trim()) return;
      checkpoints.begin(label.trim());
      vscode.window.showInformationMessage(
        `YargiX: checkpoint “${label.trim()}” opened — files edited from now on can be rewound to this point.`,
      );
    }),

    vscode.commands.registerCommand("yargix.checkpoint.clear", async () => {
      if (!checkpoints.count()) {
        vscode.window.showInformationMessage("YargiX: no checkpoints to clear.");
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Delete all ${checkpoints.count()} checkpoint(s)?`,
        { modal: true, detail: "You will no longer be able to rewind past edits." },
        "Delete",
      );
      if (ok !== "Delete") return;
      checkpoints.clear();
      vscode.window.showInformationMessage("YargiX: checkpoints cleared.");
    }),
  );
}
