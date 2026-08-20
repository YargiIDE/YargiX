/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * A small, curated catalog of MCP servers that can be added in one click.
 *
 * Deliberately not a live marketplace: adding a server means running its
 * command on the user's machine, so the list stays short, hand-checked, and
 * pinned to packages whose identifiers were verified against their registries.
 * Anything else is still available through "Add server" by hand.
 *
 * Shared by the extension host and the settings webview.
 */

export type McpCatalogCategory = "files" | "web" | "data" | "dev" | "thinking";

export interface McpCatalogEntry {
  id: string;
  /** Name given to the created server config. */
  name: string;
  description: string;
  category: McpCatalogCategory;
  /** Executable to launch (stdio transport). */
  command: string;
  args: string[];
  /**
   * When set, this argument is appended and prefilled with the workspace path,
   * because the server is scoped to a directory.
   */
  needsWorkspacePath?: boolean;
  /** Environment variables the user must fill in before it will work. */
  requiredEnv?: { key: string; hint: string }[];
  /** Where to read more. */
  docs: string;
  /** Extra runtime the user needs, shown as a warning. */
  requires?: string;
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read and write files under a directory you choose, with the server enforcing the boundary.",
    category: "files",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    needsWorkspacePath: true,
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "git",
    name: "Git",
    description: "Inspect a repository: history, diffs, blame and branches, without shelling out.",
    category: "dev",
    command: "uvx",
    args: ["mcp-server-git", "--repository"],
    needsWorkspacePath: true,
    requires: "uv (Python) must be installed — see https://docs.astral.sh/uv/",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch a URL and convert it to Markdown for the model to read.",
    category: "web",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Full browser automation across Chrome, Firefox and WebKit. Heavier than the built-in Browser tool, but far more capable.",
    category: "web",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    requires: "Downloads browser binaries on first run (~150 MB).",
    docs: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "memory",
    name: "Knowledge Graph Memory",
    description: "A graph-shaped memory of entities and relations. Complements YargiX's own memory bank when you need structure.",
    category: "thinking",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequentialthinking",
    name: "Sequential Thinking",
    description: "A scratchpad for step-by-step reasoning on problems that need to be broken down.",
    category: "thinking",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequentialthinking"],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "time",
    name: "Time",
    description: "Current time and timezone conversion — useful when the model must reason about dates.",
    category: "data",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-time"],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "everything",
    name: "Everything (test server)",
    description: "Reference server exercising every MCP feature. Handy for checking that MCP itself is wired up.",
    category: "dev",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
  },
];

/** Config shape the catalog produces; mirrors McpServerConfig. */
export interface CatalogServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

/**
 * Turn a catalog entry into a server config.
 *
 * Servers that scope themselves to a directory get the workspace path appended;
 * without it they would either refuse to start or, worse, default to somewhere
 * broader than the user expects.
 */
export function configFromCatalog(entry: McpCatalogEntry, workspacePath: string): CatalogServerConfig {
  const args = [...entry.args];
  if (entry.needsWorkspacePath && workspacePath) args.push(workspacePath);
  const env: Record<string, string> = {};
  for (const e of entry.requiredEnv ?? []) env[e.key] = "";
  return {
    name: entry.name,
    transport: "stdio",
    command: entry.command,
    args,
    env: Object.keys(env).length ? env : undefined,
    enabled: true,
  };
}

/** True when `name` is already taken by an existing server. */
export function isAlreadyAdded(entry: McpCatalogEntry, existing: { name: string }[]): boolean {
  return existing.some((s) => s.name.trim().toLowerCase() === entry.name.toLowerCase());
}
