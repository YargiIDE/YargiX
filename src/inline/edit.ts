/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { editCode } from "../agent/provider";
import { pendingChanges } from "../stores/pendingChanges";
import { toWorkspacePath } from "../context/workspaceUtils";
import { logError } from "../logging";
import type { InlineDeps } from "./completions";

// Context sent around the selection so the model matches local style/imports.
const CTX_BEFORE = 2000;
const CTX_AFTER = 1000;

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** The range to rewrite: the selection, or the whole current line when empty. */
function targetRange(editor: vscode.TextEditor): vscode.Range {
  const sel = editor.selection;
  if (!sel.isEmpty) return new vscode.Range(sel.start, sel.end);
  return editor.document.lineAt(sel.active.line).range;
}

async function runInlineEdit(deps: InlineDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("YargiX: open a file first.");
    return;
  }

  const range = targetRange(editor);
  const selection = editor.document.getText(range);
  if (!selection.trim()) {
    vscode.window.showWarningMessage("YargiX: select some code to edit.");
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "YargiX — Edit selection",
    prompt: "Describe the change (e.g. “add error handling”, “convert to async”)",
    placeHolder: "What should this code become?",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const target = await deps.resolveInlineTarget();
  if (!target) {
    vscode.window.showErrorMessage("YargiX: no model configured. Open settings to add a provider.");
    return;
  }

  const doc = editor.document;
  const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), range.start)).slice(-CTX_BEFORE);
  const after = doc.getText(new vscode.Range(range.end, docEnd)).slice(0, CTX_AFTER);
  // Capture the pre-edit text now: the Keep/Undo review diffs against this.
  const originalDocText = doc.getText();

  const replacement = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "YargiX: editing…", cancellable: true },
    async (_progress, token) => {
      const ctrl = new AbortController();
      const sub = token.onCancellationRequested(() => ctrl.abort());
      try {
        return await editCode({
          apiBaseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          anthropic: target.anthropic,
          oauthKind: target.oauthKind,
          selection,
          instruction: instruction.trim(),
          before,
          after,
          language: doc.languageId,
          fileName: baseName(doc.uri.fsPath),
          signal: ctrl.signal,
        });
      } catch (error) {
        if (!ctrl.signal.aborted) {
          logError("inline.edit", error);
          vscode.window.showErrorMessage(`YargiX: edit failed — ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      } finally {
        sub.dispose();
      }
    },
  );

  if (replacement === undefined) return;
  if (!replacement.trim() || replacement === selection) {
    vscode.window.setStatusBarMessage("YargiX: no change", 2000);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, replacement);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage("YargiX: could not apply the edit.");
    return;
  }

  // Register with the same review store the agent uses, so the edit gets the
  // usual per-hunk Keep / Undo affordances instead of being a silent write.
  try {
    pendingChanges.record(toWorkspacePath(doc.uri.fsPath), originalDocText, doc.getText(), true);
  } catch (error) {
    // File outside the workspace — the edit still applied, just untracked.
    logError("inline.edit.track", error);
  }
}

/** Register the Ctrl+I / Cmd+I inline edit command. */
export function registerInlineEdit(context: vscode.ExtensionContext, deps: InlineDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("yargix.inlineEdit", () => runInlineEdit(deps)),
  );
}
