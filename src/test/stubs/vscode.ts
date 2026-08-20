/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Minimal `vscode` stand-in for unit tests.
 *
 * Pure logic (approval policy, diffing, path handling) reaches the editor API
 * only for the workspace root and open tabs, so a tiny stub lets those modules
 * run under plain Node instead of a full Extension Host.
 */

/** Workspace root the stub reports; tests override it. */
let root = process.cwd();

export function __setWorkspaceRoot(dir: string): void {
  root = dir;
}

class StubUri {
  private constructor(public readonly scheme: string, public readonly fsPath: string) {}
  static file(p: string): StubUri {
    return new StubUri("file", p);
  }
  static parse(value: string): StubUri {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
    if (!m) return new StubUri("file", value);
    let p = m[2];
    // file://localhost/C:/x and file:///C:/x both reduce to a plain path.
    p = p.replace(/^localhost/i, "");
    if (!p.startsWith("/")) p = `/${p}`;
    // Windows drive paths come back as "/C:/x" — drop the leading slash.
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
    return new StubUri(m[1].toLowerCase(), p);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export const Uri = StubUri;
export type Uri = StubUri;

/** Minimal EventEmitter matching the shape modules construct at import time. */
export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();
  event = (fn: (e: T) => void): { dispose(): void } => {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  };
  fire(e: T): void {
    for (const fn of [...this.listeners]) fn(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export const workspace = {
  get workspaceFolders() {
    return [{ uri: StubUri.file(root), name: "stub", index: 0 }];
  },
};

export const window = {
  tabGroups: { all: [] as { tabs: { input?: { uri?: StubUri } }[] }[] },
  /** Logging falls back to this; tests keep the output silent. */
  createOutputChannel(_name: string) {
    return { appendLine() {}, append() {}, show() {}, dispose() {}, clear() {} };
  },
};
