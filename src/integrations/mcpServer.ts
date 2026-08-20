/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * MCP *server*: exposes YargiX's own tools to external MCP clients over
 * JSON-RPC on loopback HTTP. The client side lives in `mcpClient.ts`; this is
 * the mirror image, so other editors/agents can drive this workspace.
 *
 * Off by default. Binds to 127.0.0.1 only, and serves read-only tools unless
 * the user explicitly opts into mutating ones.
 */

import * as vscode from "vscode";
import * as http from "http";
import { TOOLS, MUTATING_TOOLS, type ToolContext } from "../agent/tools";
import { logError } from "../logging";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "yargix", version: "0.1.0" };
/** Refuse absurd bodies outright rather than buffering them. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

function cfg() {
  const c = vscode.workspace.getConfiguration("yargix");
  return {
    enabled: c.get<boolean>("mcpServer.enabled", false),
    port: c.get<number>("mcpServer.port", 39273),
    allowMutating: c.get<boolean>("mcpServer.allowMutatingTools", false),
  };
}

/** Tool names this server is willing to expose. */
function exposedToolNames(allowMutating: boolean): string[] {
  return Object.keys(TOOLS).filter((name) => {
    // Interactive/agent-coordination tools make no sense to a foreign client.
    if (name === "AskQuestion" || name === "Task" || name === "SwitchMode") return false;
    return allowMutating || !MUTATING_TOOLS.has(name);
  });
}

function toolList(allowMutating: boolean) {
  return exposedToolNames(allowMutating).map((name) => {
    const fn = TOOLS[name].schema.function;
    return { name: fn.name, description: fn.description, inputSchema: fn.parameters };
  });
}

async function callTool(name: string, args: any, allowMutating: boolean) {
  if (!exposedToolNames(allowMutating).includes(name)) {
    throw new Error(`tool "${name}" is not exposed by this server`);
  }
  const ctx: ToolContext = { todos: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const result = await TOOLS[name].execute(args ?? {}, ctrl.signal, `mcp-${Date.now()}`, ctx);
    return { content: [{ type: "text", text: result.output ?? "" }] };
  } finally {
    clearTimeout(timer);
  }
}

/** Dispatch one JSON-RPC request. Returns undefined for notifications. */
async function dispatch(req: RpcRequest): Promise<object | undefined> {
  const { allowMutating } = cfg();
  const reply = (result: object) => ({ jsonrpc: "2.0", id: req.id ?? null, result });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return undefined; // notification: no response
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList(allowMutating) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      try {
        return reply(await callTool(name, req.params?.arguments, allowMutating));
      } catch (error) {
        // Tool failures are reported in-band so the client's model can react.
        return reply({
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class McpServer {
  private server: http.Server | undefined;
  private port = 0;

  get running(): boolean {
    return !!this.server;
  }
  get address(): string {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : "";
  }

  async start(port: number): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        logError("mcpServer.handle", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Loopback only — never expose the workspace to the network.
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("POST only");
      return;
    }
    const raw = await readBody(req);
    let parsed: RpcRequest | RpcRequest[];
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    // A batch of notifications yields nothing to send back.
    const out = Array.isArray(parsed)
      ? (await Promise.all(parsed.map(dispatch))).filter(Boolean)
      : await dispatch(parsed);
    if (!out || (Array.isArray(out) && !out.length)) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }
}

const mcpServer = new McpServer();

async function sync(): Promise<void> {
  const { enabled, port } = cfg();
  if (enabled && !mcpServer.running) {
    try {
      await mcpServer.start(port);
      vscode.window.setStatusBarMessage(`YargiX MCP server on ${mcpServer.address}`, 4000);
    } catch (error) {
      logError("mcpServer.start", error);
      vscode.window.showErrorMessage(
        `YargiX: MCP server could not start on port ${port} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (!enabled && mcpServer.running) {
    mcpServer.stop();
  }
}

/** Register the MCP server: starts when enabled, follows the setting live. */
export function registerMcpServer(context: vscode.ExtensionContext): void {
  void sync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yargix.mcpServer")) void sync();
    }),
    vscode.commands.registerCommand("yargix.mcpServer.showAddress", async () => {
      if (!mcpServer.running) {
        vscode.window.showInformationMessage("YargiX: MCP server is off (enable yargix.mcpServer.enabled).");
        return;
      }
      const copy = await vscode.window.showInformationMessage(`YargiX MCP server: ${mcpServer.address}`, "Copy");
      if (copy) await vscode.env.clipboard.writeText(mcpServer.address);
    }),
    { dispose: () => mcpServer.stop() },
  );
}
