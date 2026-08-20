/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Propagate an edit across the codebase ("tab to jump").
 *
 * After you change something, the same change usually has to happen in a few
 * other places. This watches your last edit, finds the candidate lines by local
 * text search, asks the model which of them genuinely need the analogous
 * change, then walks you through them one keypress at a time.
 *
 * The model only ever judges and rewrites lines we found ourselves, so it can
 * never point at a file or line that does not exist.
 */

import * as vscode from "vscode";
import { suggestRelatedEdits, type RelatedEditCandidate, type RelatedEditSuggestion } from "../agent/provider";
import { pendingChanges } from "../stores/pendingChanges";
import { toWorkspacePath } from "../context/workspaceUtils";
import { logError } from "../logging";
import type { InlineDeps } from "./completions";

/** Identifiers shorter than this are too noisy to search for. */
const MIN_TOKEN = 4;
/** Upper bound on files scanned for candidates. */
const MAX_FILES = 400;
/** Upper bound on candidate lines sent to the model. */
const MAX_CANDIDATES = 40;
/** Skip files this large — they are usually generated or vendored. */
const MAX_FILE_BYTES = 400_000;
/** Lines of context shown around each candidate. */
const CONTEXT_LINES = 2;

interface LastEdit {
  uri: vscode.Uri;
  before: string;
  after: string;
  at: number;
}

let lastEdit: LastEdit | undefined;
let queue: RelatedEditSuggestion[] = [];
let cursor = 0;
/**
 * Pre-change line contents for the document currently being typed in. Only one
 * document is kept, so this never grows with the size of the session.
 */
const prevLines = new Map<string, string[]>();

// ---------------------------------------------------------------- candidates

/** Identifier-like tokens that the edit removed or changed. */
export function distinctiveTokens(before: string, after: string): string[] {
  const words = (s: string) => s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const afterCounts = new Map<string, number>();
  for (const w of words(after)) afterCounts.set(w, (afterCounts.get(w) ?? 0) + 1);

  const scored = new Map<string, number>();
  for (const w of words(before)) {
    if (w.length < MIN_TOKEN) continue;
    // A token the edit removed (or used less) is what other sites will share.
    const removed = (scored.get(w) ?? 0) + 1;
    scored.set(w, removed);
  }
  const out: string[] = [];
  for (const [w, count] of scored) {
    const remaining = afterCounts.get(w) ?? 0;
    if (remaining < count) out.push(w); // genuinely reduced by the edit
  }
  // Nothing was removed (pure addition) → fall back to the longest shared names.
  if (!out.length) {
    for (const [w] of scored) out.push(w);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, 3);
}

/** Build the context block shown to the model for one candidate line. */
function contextAround(lines: string[], index: number): string {
  const from = Math.max(0, index - CONTEXT_LINES);
  const to = Math.min(lines.length - 1, index + CONTEXT_LINES);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${i + 1}${i === index ? " >" : "  "} ${lines[i]}`);
  }
  return out.join("\n");
}

async function findCandidates(
  tokens: string[],
  skip: vscode.Uri,
  token: vscode.CancellationToken,
): Promise<RelatedEditCandidate[]> {
  if (!tokens.length) return [];
  const pattern = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,dist,out,build,.git,vendor,target,__pycache__}/**",
    MAX_FILES,
  );

  const out: RelatedEditCandidate[] = [];
  for (const uri of files) {
    if (token.isCancellationRequested) break;
    if (uri.fsPath === skip.fsPath) continue;
    if (out.length >= MAX_CANDIDATES) break;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) continue;

    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      continue;
    }
    if (!pattern.test(text)) continue;

    const lines = text.split(/\r?\n/);
    const rel = vscode.workspace.asRelativePath(uri, false);
    for (let i = 0; i < lines.length && out.length < MAX_CANDIDATES; i++) {
      if (!pattern.test(lines[i])) continue;
      out.push({ file: rel, line: i + 1, text: lines[i], context: contextAround(lines, i) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the walk

function statusFor(status: vscode.StatusBarItem) {
  if (cursor >= queue.length) {
    status.hide();
    return;
  }
  const s = queue[cursor];
  status.text = `$(arrow-right) Edit ${cursor + 1}/${queue.length}: ${s.file.split(/[\\/]/).pop()}`;
  status.tooltip = `${s.file}:${s.line} — ${s.reason || "related change"}\nRun “YargiX: Apply and Jump to Next Edit” to apply.`;
  status.show();
}

/** Open the current suggestion and highlight the line it would change. */
async function revealCurrent(): Promise<vscode.TextEditor | undefined> {
  const s = queue[cursor];
  if (!s) return undefined;
  try {
    // Candidates carry workspace-relative paths, resolved against the root.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const abs = root ? vscode.Uri.joinPath(root, s.file) : vscode.Uri.file(s.file);
    const doc = await vscode.workspace.openTextDocument(abs);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
    const line = Math.min(Math.max(0, s.line - 1), doc.lineCount - 1);
    const range = doc.lineAt(line).range;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return editor;
  } catch (error) {
    logError("nextEdit.reveal", error, { file: s.file });
    return undefined;
  }
}

/** Apply the current suggestion, tracked so Keep/Undo and checkpoints cover it. */
async function applyCurrent(): Promise<boolean> {
  const s = queue[cursor];
  if (!s) return false;
  const editor = await revealCurrent();
  if (!editor) return false;
  const doc = editor.document;
  const line = Math.min(Math.max(0, s.line - 1), doc.lineCount - 1);
  const range = doc.lineAt(line).range;
  if (doc.getText(range) === s.replacement) return true; // already applied

  const originalDocText = doc.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, s.replacement);
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  try {
    pendingChanges.record(toWorkspacePath(doc.uri.fsPath), originalDocText, doc.getText(), true);
  } catch (error) {
    logError("nextEdit.track", error);
  }
  return true;
}

async function computeQueue(deps: InlineDeps, status: vscode.StatusBarItem): Promise<void> {
  const edit = lastEdit;
  if (!edit) {
    vscode.window.showInformationMessage("YargiX: make an edit first, then run this to propagate it.");
    return;
  }
  const target = await deps.resolveInlineTarget();
  if (!target) {
    vscode.window.showErrorMessage("YargiX: no model configured. Open settings to add a provider.");
    return;
  }
  const tokens = distinctiveTokens(edit.before, edit.after);
  if (!tokens.length) {
    vscode.window.showInformationMessage("YargiX: that edit has nothing distinctive to search for.");
    return;
  }

  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "YargiX: finding related edits…", cancellable: true },
    async (_p, token) => {
      const ctrl = new AbortController();
      const sub = token.onCancellationRequested(() => ctrl.abort());
      try {
        const candidates = await findCandidates(tokens, edit.uri, token);
        if (!candidates.length || token.isCancellationRequested) return [];
        return await suggestRelatedEdits({
          apiBaseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          anthropic: target.anthropic,
          oauthKind: target.oauthKind,
          before: edit.before,
          after: edit.after,
          editedFile: vscode.workspace.asRelativePath(edit.uri, false),
          language: vscode.window.activeTextEditor?.document.languageId,
          candidates,
          signal: ctrl.signal,
        });
      } catch (error) {
        if (!ctrl.signal.aborted) {
          logError("nextEdit.suggest", error);
          vscode.window.showErrorMessage(
            `YargiX: could not find related edits — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return [];
      } finally {
        sub.dispose();
      }
    },
  );

  queue = found;
  cursor = 0;
  if (!queue.length) {
    vscode.window.setStatusBarMessage("YargiX: no related edits found", 3000);
    status.hide();
    return;
  }
  statusFor(status);
  await revealCurrent();
}

/** Register edit tracking, the walk commands, and the status indicator. */
export function registerNextEdit(context: vscode.ExtensionContext, deps: InlineDeps): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.command = "yargix.nextEdit.apply";

  context.subscriptions.push(
    status,

    // Remember the user's last edit. The change event only reports the *new*
    // text, so the previous line contents are kept for the document being typed
    // in — otherwise "before" and "after" would both be the post-edit text.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file" || !e.contentChanges.length) return;
      const key = e.document.uri.toString();
      const previous = prevLines.get(key);
      // Snapshot for the *next* change before anything else can return early.
      prevLines.clear();
      prevLines.set(key, e.document.getText().split(/\r?\n/));

      if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) return;
      const change = e.contentChanges[0];
      // Single keystrokes are noise; wait for a substantive change.
      if (change.text.length <= 2 && change.rangeLength <= 2) return;
      if (!previous) return; // first change in this document — no baseline yet

      const startLine = change.range.start.line;
      const before = previous.slice(startLine, change.range.end.line + 1).join("\n");
      const afterLine = Math.min(startLine, e.document.lineCount - 1);
      const after = e.document.lineAt(afterLine).text;
      if (!before.trim() && !after.trim()) return;
      lastEdit = { uri: e.document.uri, before, after, at: Date.now() };
    }),

    vscode.commands.registerCommand("yargix.nextEdit.find", () => computeQueue(deps, status)),

    vscode.commands.registerCommand("yargix.nextEdit.apply", async () => {
      if (!queue.length) {
        await computeQueue(deps, status);
        return;
      }
      if (await applyCurrent()) cursor++;
      if (cursor >= queue.length) {
        queue = [];
        cursor = 0;
        status.hide();
        vscode.window.setStatusBarMessage("YargiX: all related edits applied", 3000);
        return;
      }
      statusFor(status);
      await revealCurrent();
    }),

    vscode.commands.registerCommand("yargix.nextEdit.skip", async () => {
      if (!queue.length) return;
      cursor++;
      if (cursor >= queue.length) {
        queue = [];
        cursor = 0;
        status.hide();
        return;
      }
      statusFor(status);
      await revealCurrent();
    }),

    vscode.commands.registerCommand("yargix.nextEdit.cancel", () => {
      queue = [];
      cursor = 0;
      status.hide();
    }),
  );
}
