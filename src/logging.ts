/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";

let output: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("YargiX");
  context.subscriptions.push(output);
  return output;
}

export function getLog(): vscode.OutputChannel {
  return (output ??= vscode.window.createOutputChannel("YargiX"));
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    return typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function logError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  let details = "";
  try {
    if (context) details = ` ${JSON.stringify(context)}`;
  } catch {
    details = " [unserializable context]";
  }
  try {
    getLog().appendLine(`[${new Date().toISOString()}] [error] [${scope}]${details} ${errorText(error)}`);
  } catch {
    console.error(`[YargiX] [${scope}]`, error);
  }
}
