/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * First-run guidance.
 *
 * YargiX is useless until a model is connected, and nothing in a blank chat
 * panel says how to do that. The walkthrough opens once, on the first
 * activation, and never again unless the user asks for it.
 */

import * as vscode from "vscode";
import { logError } from "../logging";

const SHOWN_KEY = "yargix.welcome.shown.v1";
const WALKTHROUGH_ID = "yargix.welcome";

/** Fully-qualified walkthrough id: `<publisher>.<name>#<walkthrough>`. */
function walkthroughId(context: vscode.ExtensionContext): string {
  return `${context.extension.id}#${WALKTHROUGH_ID}`;
}

async function open(context: vscode.ExtensionContext): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openWalkthrough", walkthroughId(context), false);
}

/** Register the welcome command and show the guide on first activation. */
export function registerWelcome(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("yargix.showWelcome", async () => {
      try {
        await open(context);
      } catch (error) {
        logError("welcome.open", error);
      }
    }),
  );

  if (context.globalState.get<boolean>(SHOWN_KEY)) return;
  // Record it first: a failure to open must not make this retry on every start.
  void context.globalState.update(SHOWN_KEY, true).then(
    () => open(context).catch((error) => logError("welcome.firstRun", error)),
    (error) => logError("welcome.state", error),
  );
}
