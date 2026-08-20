/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { completeCode } from "../agent/provider";
import type { OAuthKind } from "../agent/oauth";
import { logError } from "../logging";

/** The provider + model the inline feature should call. */
export interface InlineTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  anthropic: boolean;
  oauthKind?: OAuthKind;
}

export interface InlineDeps {
  /** Resolve the active provider/model, or undefined when none is usable. */
  resolveInlineTarget(): Promise<InlineTarget | undefined>;
}

// How much surrounding source to send. Enough for real context, bounded so a
// huge file never balloons the request (and its latency/cost).
const MAX_PREFIX = 4000;
const MAX_SUFFIX = 1500;

/** Wait `ms`, resolving false if the request is cancelled while we wait. */
function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    let sub: vscode.Disposable | undefined;
    const t = setTimeout(() => { sub?.dispose(); resolve(true); }, ms);
    sub = token.onCancellationRequested(() => { clearTimeout(t); sub?.dispose(); resolve(false); });
  });
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Drop any trailing part of the completion that just duplicates the start of
 *  the suffix (models like to re-type the code that follows the cursor). */
function trimOverlap(text: string, suffix: string): string {
  if (!text || !suffix) return text;
  const head = suffix.slice(0, 80);
  for (let n = Math.min(text.length, head.length); n > 0; n--) {
    if (text.endsWith(head.slice(0, n))) return text.slice(0, text.length - n);
  }
  return text;
}

class YargiXInlineProvider implements vscode.InlineCompletionItemProvider {
  private lastKey = "";
  private lastText = "";

  constructor(private readonly deps: InlineDeps) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = vscode.workspace.getConfiguration("yargix");
    if (!cfg.get<boolean>("inlineCompletions.enabled", false)) return;
    // Only real editable documents — skip output panes, diffs, git scm, etc.
    if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return;

    // Debounce: keystrokes cancel the in-flight token, so a superseded request
    // bails here before spending a model call.
    const debounceMs = Math.max(0, cfg.get<number>("inlineCompletions.debounceMs", 300));
    if (debounceMs && !(await sleep(debounceMs, token))) return;
    if (token.isCancellationRequested) return;

    const target = await this.deps.resolveInlineTarget();
    if (!target || token.isCancellationRequested) return;

    const prefixFull = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const docEnd = document.lineAt(document.lineCount - 1).range.end;
    const suffixFull = document.getText(new vscode.Range(position, docEnd));
    const prefix = prefixFull.slice(-MAX_PREFIX);
    const suffix = suffixFull.slice(0, MAX_SUFFIX);
    if (!prefix.trim()) return;

    // Identical cursor context → reuse the last completion (no new request). Keeps
    // the ghost text stable as VS Code re-queries during the same edit.
    const key = `${document.uri.toString()}::${prefix.length}::${prefix.slice(-120)}::${suffix.slice(0, 120)}`;
    if (key === this.lastKey && this.lastText) {
      return [new vscode.InlineCompletionItem(this.lastText, new vscode.Range(position, position))];
    }

    const ctrl = new AbortController();
    const sub = token.onCancellationRequested(() => ctrl.abort());
    try {
      const maxTokens = Math.max(16, Math.min(512, cfg.get<number>("inlineCompletions.maxTokens", 256)));
      let text = await completeCode({
        apiBaseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        anthropic: target.anthropic,
        oauthKind: target.oauthKind,
        prefix,
        suffix,
        language: document.languageId,
        fileName: baseName(document.uri.fsPath),
        maxTokens,
        signal: ctrl.signal,
      });
      text = trimOverlap(text, suffix);
      if (!text.trim() || token.isCancellationRequested) return;
      this.lastKey = key;
      this.lastText = text;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    } catch (error) {
      if (!ctrl.signal.aborted) logError("inline.complete", error);
      return;
    } finally {
      sub.dispose();
    }
  }
}

/** Register the inline (ghost-text) completion provider for all documents. */
export function registerInlineCompletions(context: vscode.ExtensionContext, deps: InlineDeps): void {
  const provider = new YargiXInlineProvider(deps);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
  );

  // Quick toggle command (bindable / palette) that flips the enabled setting.
  context.subscriptions.push(
    vscode.commands.registerCommand("yargix.toggleInlineCompletions", async () => {
      const cfg = vscode.workspace.getConfiguration("yargix");
      const next = !cfg.get<boolean>("inlineCompletions.enabled", false);
      await cfg.update("inlineCompletions.enabled", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`YargiX autocomplete ${next ? "on" : "off"}`, 2000);
    }),
  );
}
