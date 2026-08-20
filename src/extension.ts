/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from 'vscode';
import { SettingsManager } from './stores/settingsManager';
import { SidebarProvider } from './ui/sidebarProvider';
import { registerInlineReview } from './ui/inlineReview';
import { registerInlineCompletions } from './inline/completions';
import { registerInlineEdit } from './inline/edit';
import { registerNextEdit } from './inline/nextEdit';
import { registerWorktrees } from './integrations/worktree';
import { registerMcpServer } from './integrations/mcpServer';
import { registerTerminalCapture } from './integrations/terminalCapture';
import { browserSession } from './integrations/browser';
import { registerQuickFix } from './ui/quickFix';
import { registerCheckpointsUi } from './ui/checkpointsUi';
import { registerChangesTree } from './ui/changesTree';
import { registerWelcome } from './ui/welcome';
import { checkpoints } from './stores/checkpoints';
import { registerGitSync } from './integrations/gitSync';
import { SettingsPanel } from './ui/settingsPanel';
import { FeatureStore } from './stores/featureStore';
import { setToolTimeoutOverrides, setPlanApprovalRequired } from './agent/tools/shared';
import { mcpManager } from './integrations/mcpClient';
import { setIndexStorageDir } from './agent/semanticIndex';
import { setDocsStorageDir, setDocSourcesProvider } from './agent/docsIndex';
import { initIndexWatch } from './agent/indexWatch';
import { initLlamacpp, checkInstalled, loadModel, disposeLlamacpp } from './agent/llamacpp';
import { initOAuth } from './agent/oauth';
import { initUsage } from './stores/usageStore';
import { initModelRegistry, applyEmbedModel } from './stores/modelRegistry';
import { initRuntimeDeps } from './runtimeDeps';
import { initLog, logError } from './logging';

export function activate(context: vscode.ExtensionContext) {
  const log = initLog(context);
  log.appendLine(`[${new Date().toISOString()}] YargiX activated`);

  // Heavy native deps (onnxruntime, sharp, transformers) are not shipped in the
  // VSIX; they are downloaded to globalStorage on first use.
  initRuntimeDeps(context.globalStorageUri.fsPath);

  const settingsManager = new SettingsManager(context);
  const featureStore = new FeatureStore(context);
  const syncToolTimeouts = () => setToolTimeoutOverrides(featureStore.get().toolTimeoutsSec);
  syncToolTimeouts();
  context.subscriptions.push(featureStore.onDidChange(syncToolTimeouts));

  // Plan review gate: leaving plan mode asks the user to sign off on the plan.
  const syncPlanApproval = () =>
    setPlanApprovalRequired(vscode.workspace.getConfiguration('yargix').get<boolean>('plan.requireApproval', true));
  syncPlanApproval();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('yargix.plan.requireApproval')) syncPlanApproval();
    })
  );
  initOAuth(context);
  initUsage(context);
  // Prefetch the provider-grouped model list so every UI (settings, pickers)
  // renders instantly from the backend cache.
  initModelRegistry(featureStore, settingsManager);

  // Local semantic index: vectors in globalStorage; warm disk + incremental sync.
  setIndexStorageDir(context.globalStorageUri.fsPath);
  setDocsStorageDir(context.globalStorageUri.fsPath);
  setDocSourcesProvider(() => featureStore.get().docSources ?? []);
  applyEmbedModel(featureStore.get().embedModel || "minilm")
    .catch((error) => logError("startup.embed-model", error))
    .finally(() => initIndexWatch(context, featureStore));

  // Connect any enabled MCP servers in the background.
  void mcpManager.sync(featureStore.get().mcpServers).catch((error) => logError("startup.mcp", error));

  // llama.cpp local models: detect install, then auto-load flagged models.
  initLlamacpp(context);
  void checkInstalled().then(() => {
    const f = featureStore.get();
    for (const m of f.llamacppModels) {
      if (m.autoLoad) void loadModel(m, f.llamacppConfig).catch((error) => logError("startup.llamacpp-load", error, { model: m.id }));
    }
  }).catch((error) => logError("startup.llamacpp-check", error));

  const sidebarProvider = new SidebarProvider(context, settingsManager, featureStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      // Keep the chat webview (and any in-flight agent run's UI state) alive when
      // hidden/collapsed or switched away, so reopening never resets to a blank chat.
      webviewOptions: { retainContextWhenHidden: true },
    })

  );

  // Inline diff view for agent edits + changed-line decorations (no git needed).
  registerInlineReview(context);

  // Copilot-style inline (ghost-text) autocomplete + Ctrl+I edit-in-place, both
  // powered by the selected chat model.
  const inlineDeps = { resolveInlineTarget: () => sidebarProvider.resolveInlineTarget() };
  registerInlineCompletions(context, inlineDeps);
  registerInlineEdit(context, inlineDeps);
  // Propagate an edit to the other places that need the same change.
  registerNextEdit(context, inlineDeps);

  // Ephemeral git worktrees so risky work can run off the main tree.
  registerWorktrees(context);

  // Expose YargiX's own tools to other MCP clients.
  registerMcpServer(context);

  // Watch the user's own terminals so @terminal and ReadTerminal carry real
  // command output, then offer one-click routes from a failure into the chat.
  registerTerminalCapture(context);
  registerQuickFix(context, sidebarProvider);

  // Checkpoints: stash pre-edit file contents so a whole run can be rewound.
  void checkpoints.init(context.globalStorageUri.fsPath).catch((error) => logError("startup.checkpoints", error));
  registerCheckpointsUi(context);

  // Cross-file review: every pending change in one list, with keep/undo.
  registerChangesTree(context);

  // First run: show how to connect a model, because nothing works until one is.
  registerWelcome(context);

  // Committing in git counts as "keep" — clear those pending reviews.
  registerGitSync(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('yargix.openSettings', (section?: string) => {
      SettingsPanel.createOrShow(context, settingsManager, featureStore, section);
    })
  );

  // Ctrl+L: add the current selection (or file) to chat as a mention.
  context.subscriptions.push(
    vscode.commands.registerCommand('yargix.addToChat', () => sidebarProvider.addSelectionToChat())
  );

  context.subscriptions.push({ dispose: () => browserSession.dispose() });
  context.subscriptions.push({ dispose: () => mcpManager.disposeAll() });
  context.subscriptions.push({ dispose: () => disposeLlamacpp() });
}

export function deactivate() {
  browserSession.dispose();
  mcpManager.disposeAll();
  disposeLlamacpp();
}
