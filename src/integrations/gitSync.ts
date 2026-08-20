/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { pendingChanges } from "../stores/pendingChanges";
import { safePath } from "../context/workspaceUtils";

/**
 * A committed edit is no longer unreviewed: committing in git is an explicit
 * "keep". Once a pending file goes clean vs HEAD/index we drop it, so the
 * Keep All / Undo All bar only ever lists changes git still considers dirty.
 *
 * ponytail: rides the built-in git extension's repository state instead of
 * shelling out to `git status`. If the git extension is disabled, or the file
 * lives outside a repo, changes stay pending exactly as before.
 */

/** Absolute paths we have observed as dirty — only these can be auto-kept. */
const seenDirty = new Set<string>();

export function registerGitSync(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension<any>("vscode.git");
  if (!ext) return;
  void ext.activate().then((gitExt: any) => {
    const api = gitExt?.getAPI?.(1);
    if (!api) return;
    const hook = (repo: any) => {
      sync(repo);
      context.subscriptions.push(repo.state.onDidChange(() => sync(repo)));
    };
    for (const repo of api.repositories) hook(repo);
    context.subscriptions.push(api.onDidOpenRepository(hook));
  });
}

function sync(repo: any) {
  const root: string = repo.rootUri?.fsPath ?? "";
  const dirty = new Set<string>(
    [
      ...(repo.state.workingTreeChanges ?? []),
      ...(repo.state.indexChanges ?? []),
      ...(repo.state.mergeChanges ?? []),
    ].map((c: any) => (c.uri as vscode.Uri).fsPath)
  );
  for (const abs of dirty) seenDirty.add(abs);

  for (const change of pendingChanges.list()) {
    let abs: string;
    try {
      abs = safePath(change.path);
    } catch {
      continue;
    }
    if (!abs.startsWith(root)) continue;
    // Never seen dirty => git ignores it (or it predates this session): leave it
    // to the user rather than silently dropping the review.
    if (!seenDirty.has(abs) || dirty.has(abs)) continue;
    pendingChanges.accept(change.path);
    seenDirty.delete(abs);
  }
}
