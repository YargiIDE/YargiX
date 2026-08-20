/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * A headless stand-in for the `vscode` module.
 *
 * The agent core (loop, tools, provider, context) is editor-agnostic in
 * substance but imports `vscode` for the workspace root, settings and a few UI
 * affordances. The CLI bundle aliases `vscode` to this file so the same code
 * runs in a terminal or in CI.
 *
 * Anything genuinely editor-only degrades instead of throwing: no diagnostics,
 * no open editors, no notifications. Unknown members resolve to inert stubs via
 * a Proxy, so a tool reaching for an API we did not anticipate returns nothing
 * rather than crashing the run.
 */

import * as nodePath from "path";

let workspaceRoot = process.cwd();
let settings: Record<string, unknown> = {};

/** Point the shim at the directory the CLI is operating on. */
export function configureShim(opts: { root?: string; settings?: Record<string, unknown> }): void {
  if (opts.root) workspaceRoot = nodePath.resolve(opts.root);
  if (opts.settings) settings = opts.settings;
}

// ------------------------------------------------------------------ basics

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri("file", p);
  }
  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
    if (!m) return new Uri("file", value);
    let p = m[2].replace(/^localhost/i, "");
    if (!p.startsWith("/")) p = `/${p}`;
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
    return new Uri(m[1].toLowerCase(), p);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, nodePath.join(base.fsPath, ...parts));
  }
  get path(): string {
    return this.fsPath.replace(/\\/g, "/");
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();
  event = (fn: (e: T) => void): Disposable => {
    this.listeners.add(fn);
    return new Disposable(() => void this.listeners.delete(fn));
  };
  fire(e: T): void {
    for (const fn of [...this.listeners]) fn(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void {
    this.fn();
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}
export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number | Position, startChar?: number | Position, endLine?: number, endChar?: number) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, (startChar as number) ?? 0);
      this.end = new Position(endLine ?? (startLine as number), endChar ?? 0);
    }
  }
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (fn: () => void) => this.emitter.event(fn),
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

// ------------------------------------------------------------------- enums

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const TextDocumentChangeReason = { Undo: 1, Redo: 2 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;
export const DecorationRangeBehavior = { OpenOpen: 0, ClosedClosed: 1 } as const;

export class ThemeIcon {
  constructor(readonly id: string) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}

// --------------------------------------------------------------- workspace

/** Read a `section.key` setting supplied by the CLI, else the caller's default. */
function readSetting<T>(section: string, key: string, fallback: T): T {
  const full = section ? `${section}.${key}` : key;
  const value = settings[full];
  return value === undefined ? fallback : (value as T);
}

export const workspace = {
  get workspaceFolders() {
    return [{ uri: Uri.file(workspaceRoot), name: nodePath.basename(workspaceRoot), index: 0 }];
  },
  get rootPath() {
    return workspaceRoot;
  },
  getConfiguration(section = "") {
    return {
      get: <T>(key: string, fallback?: T): T | undefined => readSetting(section, key, fallback as T),
      // The CLI is not a settings store; writes are accepted and ignored.
      update: async () => undefined,
      inspect: () => undefined,
      has: (key: string) => readSetting(section, key, undefined) !== undefined,
    };
  },
  asRelativePath(target: Uri | string): string {
    const p = typeof target === "string" ? target : target.fsPath;
    const rel = nodePath.relative(workspaceRoot, p);
    return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : p.replace(/\\/g, "/");
  },
  onDidChangeConfiguration: () => new Disposable(),
  onDidChangeTextDocument: () => new Disposable(),
  onDidSaveTextDocument: () => new Disposable(),
  createFileSystemWatcher: () => ({
    onDidCreate: () => new Disposable(),
    onDidChange: () => new Disposable(),
    onDidDelete: () => new Disposable(),
    dispose() {},
  }),
  findFiles: async () => [] as Uri[],
  openTextDocument: async () => {
    throw new Error("opening editors is not available in the CLI");
  },
  applyEdit: async () => false,
};

// ------------------------------------------------------------------ window

/** Notifications become stderr lines so stdout stays reserved for agent output. */
function notify(kind: string, message: string): undefined {
  process.stderr.write(`[${kind}] ${message}\n`);
  return undefined;
}

export const window = {
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  terminals: [] as { name: string }[],
  tabGroups: { all: [] as { tabs: unknown[] }[] },
  showErrorMessage: async (m: string) => notify("error", m),
  showWarningMessage: async (m: string) => notify("warn", m),
  showInformationMessage: async (m: string) => notify("info", m),
  setStatusBarMessage: () => new Disposable(),
  createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
  createOutputChannel: (_name: string) => ({
    appendLine: () => {},
    append: () => {},
    show: () => {},
    clear: () => {},
    dispose: () => {},
  }),
  createTextEditorDecorationType: () => ({ dispose() {} }),
  createTreeView: () => ({ dispose() {}, badge: undefined, title: "" }),
  showTextDocument: async () => {
    throw new Error("opening editors is not available in the CLI");
  },
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  onDidChangeVisibleTextEditors: () => new Disposable(),
  /** Progress UI collapses to just running the task. */
  withProgress: async <T>(_opts: unknown, task: (progress: unknown, token: unknown) => Promise<T>): Promise<T> =>
    task({ report: () => {} }, new CancellationTokenSource().token),
};

export const languages = {
  getDiagnostics: () => [] as unknown[],
  registerCodeActionsProvider: () => new Disposable(),
  registerInlineCompletionItemProvider: () => new Disposable(),
};

export const commands = {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
};

export const env = {
  clipboard: { writeText: async () => undefined, readText: async () => "" },
  openExternal: async () => false,
};

export const extensions = { getExtension: () => undefined };

// Everything the agent core touches must be exported by name above. Callers use
// `import * as vscode`, which snapshots a module's exports at import time, so a
// Proxy fallback cannot survive that interop — an API missing here surfaces as
// "not a constructor" / "not a function" at run time rather than degrading. The
// CLI smoke test exists to catch exactly that.
