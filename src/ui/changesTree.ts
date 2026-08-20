/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * A review panel for everything the agent changed, across all files.
 *
 * Per-hunk Keep/Undo works one file at a time, which stops scaling the moment a
 * run touches fifteen files. This tree lists every pending file with its
 * +added/-removed counts so the whole change set can be reviewed, opened, and
 * accepted or reverted from one place.
 */

import * as vscode from "vscode";
import { pendingChanges, computeHunks, type PendingChange } from "../stores/pendingChanges";

/** One changed file in the tree. */
class ChangeItem extends vscode.TreeItem {
  constructor(public readonly change: PendingChange, added: number, removed: number) {
    const name = change.path.split(/[\\/]/).pop() || change.path;
    super(name, vscode.TreeItemCollapsibleState.None);

    const dir = change.path.slice(0, change.path.length - name.length).replace(/[\\/]$/, "");
    this.description = `${dir}${dir ? "  " : ""}+${added} −${removed}`;
    this.tooltip = `${change.path}\n+${added} added, −${removed} removed${change.existedBefore ? "" : "\n(new file)"}`;
    this.resourceUri = vscode.Uri.file(change.path);
    this.iconPath = new vscode.ThemeIcon(change.existedBefore ? "diff-modified" : "diff-added");
    // Clicking a row opens the same inline diff the chat's edit cards use.
    this.command = {
      command: "yargix.viewDiff",
      title: "Open diff",
      arguments: [change.path],
    };
    this.contextValue = "yargixChange";
  }
}

class ChangesProvider implements vscode.TreeDataProvider<ChangeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event as vscode.Event<undefined>;

  refresh(): void {
    this.changed.fire();
  }
  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(item: ChangeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): ChangeItem[] {
    return pendingChanges
      .list()
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((change) => {
        let added = 0;
        let removed = 0;
        for (const h of computeHunks(change.before, change.after)) {
          added += h.afterLines.length;
          removed += h.beforeLines.length;
        }
        return new ChangeItem(change, added, removed);
      });
  }
}

/** Register the changes tree view and its accept/revert commands. */
export function registerChangesTree(context: vscode.ExtensionContext): void {
  const provider = new ChangesProvider();
  const view = vscode.window.createTreeView("yargix.changesView", { treeDataProvider: provider });

  const syncBadge = () => {
    const n = pendingChanges.count();
    view.badge = n ? { value: n, tooltip: `${n} file${n === 1 ? "" : "s"} awaiting review` } : undefined;
    view.title = n ? `Changes (${n})` : "Changes";
  };
  const refresh = () => {
    provider.refresh();
    syncBadge();
  };
  syncBadge();

  context.subscriptions.push(
    view,
    provider,
    { dispose: pendingChanges.onChange(refresh) },

    vscode.commands.registerCommand("yargix.changes.keep", (item?: ChangeItem) => {
      if (!item) return;
      pendingChanges.accept(item.change.path);
    }),

    vscode.commands.registerCommand("yargix.changes.undo", async (item?: ChangeItem) => {
      if (!item) return;
      await pendingChanges.reject(item.change.path);
    }),

    vscode.commands.registerCommand("yargix.changes.keepAll", async () => {
      const n = pendingChanges.count();
      if (!n) {
        vscode.window.showInformationMessage("YargiX: nothing to review.");
        return;
      }
      pendingChanges.acceptAll();
      vscode.window.showInformationMessage(`YargiX: kept ${n} file${n === 1 ? "" : "s"}.`);
    }),

    vscode.commands.registerCommand("yargix.changes.undoAll", async () => {
      const n = pendingChanges.count();
      if (!n) {
        vscode.window.showInformationMessage("YargiX: nothing to review.");
        return;
      }
      // Reverting rewrites files on disk, so make the blast radius explicit.
      const ok = await vscode.window.showWarningMessage(
        `Undo the agent's changes to ${n} file${n === 1 ? "" : "s"}?`,
        { modal: true, detail: "Each file returns to its state before the change. Files the agent created are deleted." },
        "Undo all",
      );
      if (ok !== "Undo all") return;
      await pendingChanges.rejectAll();
      vscode.window.showInformationMessage(`YargiX: reverted ${n} file${n === 1 ? "" : "s"}.`);
    }),
  );
}
