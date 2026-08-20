/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Two one-click routes from "something is wrong" into the chat:
 *   - a status-bar button that appears when a terminal command exits non-zero
 *   - a lightbulb code action on any squiggle in the editor
 *
 * Both only *stage* a prompt in the composer; the user still presses send.
 */

import * as vscode from "vscode";
import {
  lastFailedExecution,
  onDidChangeTerminalHistory,
  type TerminalExecution,
} from "../integrations/terminalCapture";

/** How much of a command's output to carry into the prompt. */
const MAX_OUTPUT_IN_PROMPT = 6000;

export interface ChatSink {
  sendToChat(text: string): void;
}

function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `… [earlier output elided] …\n${t.slice(-max)}`;
}

/** Prompt describing a failed terminal command. */
function terminalFixPrompt(e: TerminalExecution): string {
  const where = e.cwd ? `\nWorking directory: ${e.cwd}` : "";
  return (
    `This command failed in my terminal. Diagnose the root cause and fix it.\n\n` +
    `Command: ${e.command}\n` +
    `Exit code: ${e.exitCode}${where}\n\n` +
    "Output:\n```\n" +
    `${tail(e.output, MAX_OUTPUT_IN_PROMPT) || "(no output captured)"}\n` +
    "```\n"
  );
}

/** Prompt describing one or more diagnostics in a file. */
function diagnosticsFixPrompt(
  doc: vscode.TextDocument,
  range: vscode.Range,
  diagnostics: readonly vscode.Diagnostic[],
): string {
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const severity = (s: vscode.DiagnosticSeverity) =>
    s === vscode.DiagnosticSeverity.Error ? "error"
      : s === vscode.DiagnosticSeverity.Warning ? "warning"
        : s === vscode.DiagnosticSeverity.Information ? "info" : "hint";

  const listed = diagnostics
    .map((d) => {
      const line = d.range.start.line + 1;
      const source = d.source ? `${d.source}: ` : "";
      const code = d.code !== undefined && d.code !== null
        ? ` (${typeof d.code === "object" ? d.code.value : d.code})`
        : "";
      return `- ${rel}:${line} [${severity(d.severity)}] ${source}${d.message}${code}`;
    })
    .join("\n");

  // A little surrounding source so the model can fix without re-reading first.
  const from = Math.max(0, range.start.line - 5);
  const to = Math.min(doc.lineCount - 1, range.end.line + 5);
  const snippet = doc.getText(new vscode.Range(from, 0, to, doc.lineAt(to).text.length));

  return (
    `Fix the following problem${diagnostics.length > 1 ? "s" : ""} in @${rel}:\n\n` +
    `${listed}\n\n` +
    `Relevant code (lines ${from + 1}-${to + 1}):\n` +
    "```" + doc.languageId + "\n" +
    `${snippet}\n` +
    "```\n"
  );
}

/** Lightbulb action on any squiggle: "Fix with YargiX". */
class YargiXCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const diagnostics = context.diagnostics;
    if (!diagnostics.length) return [];
    const action = new vscode.CodeAction(
      diagnostics.length > 1 ? `Fix ${diagnostics.length} problems with YargiX` : "Fix with YargiX",
      vscode.CodeActionKind.QuickFix,
    );
    action.diagnostics = [...diagnostics];
    action.command = {
      command: "yargix.fixDiagnostics",
      title: "Fix with YargiX",
      arguments: [document.uri, range, [...diagnostics]],
    };
    return [action];
  }
}

/** Register the quick-fix code action, the terminal-failure button, and their commands. */
export function registerQuickFix(context: vscode.ExtensionContext, chat: ChatSink): void {
  // ---- lightbulb on diagnostics ----
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ pattern: "**" }, new YargiXCodeActions(), {
      providedCodeActionKinds: YargiXCodeActions.kinds,
    }),
    vscode.commands.registerCommand(
      "yargix.fixDiagnostics",
      async (uri?: vscode.Uri, range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
        // Invoked from the palette (no args): fall back to the active editor.
        const editor = vscode.window.activeTextEditor;
        const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
        if (!doc) {
          vscode.window.showWarningMessage("YargiX: open a file with a problem first.");
          return;
        }
        const target = range ?? editor?.selection ?? new vscode.Range(0, 0, 0, 0);
        const found = diagnostics?.length
          ? diagnostics
          : vscode.languages.getDiagnostics(doc.uri).filter((d) => d.range.intersection(target));
        if (!found.length) {
          vscode.window.showInformationMessage("YargiX: no problems reported here.");
          return;
        }
        chat.sendToChat(diagnosticsFixPrompt(doc, target, found));
      },
    ),
  );

  // ---- status-bar button for a failed terminal command ----
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "yargix.fixTerminalCommand";
  status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

  const refresh = () => {
    if (!vscode.workspace.getConfiguration("yargix").get<boolean>("terminal.showFixButton", true)) {
      status.hide();
      return;
    }
    const failed = lastFailedExecution();
    if (!failed) {
      status.hide();
      return;
    }
    const short = failed.command.length > 40 ? `${failed.command.slice(0, 40)}…` : failed.command;
    status.text = `$(debug-console) Fix: ${short}`;
    status.tooltip = `“${failed.command}” exited with code ${failed.exitCode}. Click to ask YargiX to fix it.`;
    status.show();
  };

  context.subscriptions.push(
    status,
    onDidChangeTerminalHistory(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yargix.terminal.showFixButton")) refresh();
    }),
    vscode.commands.registerCommand("yargix.fixTerminalCommand", () => {
      const failed = lastFailedExecution();
      if (!failed) {
        vscode.window.showInformationMessage("YargiX: no failed terminal command captured.");
        return;
      }
      chat.sendToChat(terminalFixPrompt(failed));
      // The prompt is staged; stop nagging until the next failure.
      status.hide();
    }),
  );

  refresh();
}
