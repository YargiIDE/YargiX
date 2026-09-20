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
 * Off by default. Binds to 127.0.0.1 only, requires a per-install bearer
 * token, refuses anything a browser could send (see `mcpServerGuard.ts`), and
 * serves read-only tools unless the user explicitly opts into mutating ones.
 */

import * as vscode from "vscode";
import * as http from "http";
import { TOOLS, MUTATING_TOOLS, type ToolContext } from "../agent/tools";
import { logError, logWarn } from "../logging";
import {
  checkMcpRequest,
  clientConfigSnippet,
  generateMcpToken,
  header,
  isPlausibleToken,
  negotiateProtocolVersion,
  rejectionBody,
  RejectionLedger,
  RPC_REJECTED_CODE,
  type McpRejection,
} from "./mcpServerGuard";

const SERVER_INFO = { name: "yargix", version: "0.1.0" };
/** Refuse absurd bodies rather than buffering them; drained up to the hard cap so a 413 can still be sent. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HARD_BODY_CAP_BYTES = 4 * MAX_BODY_BYTES;
const TOOL_CALL_TIMEOUT_MS = 120_000;
/** SecretStorage key for the bearer token: per user, survives restarts, never written to settings. */
export const TOKEN_SECRET_KEY = "yargix.mcpServer.token";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export interface McpServerOptions {
  /** Read live on every request, so a settings change needs no restart. */
  allowMutating: () => boolean;
  requireAuth: () => boolean;
  token: () => string | undefined;
  /** Called for every refused request; the extension logs these with rate limiting. */
  onRejected?: (rejection: McpRejection, info: { remote?: string; origin?: string; method?: string }) => void;
}

class BodyTooLarge extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
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
  const timer = setTimeout(() => ctrl.abort(), TOOL_CALL_TIMEOUT_MS);
  try {
    const result = await TOOLS[name].execute(args ?? {}, ctrl.signal, `mcp-${Date.now()}`, ctx);
    return { content: [{ type: "text", text: result.output ?? "" }] };
  } finally {
    clearTimeout(timer);
  }
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dispatch one JSON-RPC request. Returns undefined for notifications. */
async function dispatch(req: RpcRequest, allowMutating: boolean): Promise<object | undefined> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: req.id ?? null, result });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: negotiateProtocolVersion(req.params?.protocolVersion),
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
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep draining so the 413 reaches the client intact;
        // past the hard cap the sender is not a well-meaning client, so cut it off.
        tooLarge = true;
        chunks.length = 0;
        if (size > HARD_BODY_CAP_BYTES) {
          reject(new BodyTooLarge());
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => (tooLarge ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

export class McpServer {
  private server: http.Server | undefined;
  private port = 0;
  private starting: Promise<void> | undefined;

  constructor(private readonly opts: McpServerOptions) {}

  get running(): boolean {
    return !!this.server;
  }
  get listeningPort(): number {
    return this.port;
  }
  get address(): string {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : "";
  }

  /** Idempotent; overlapping calls (a setting toggled twice quickly) share one listen. */
  start(port: number): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.listen(port).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async listen(port: number): Promise<void> {
    if (this.opts.requireAuth() && !this.opts.token()) {
      throw new Error("no bearer token is available, so the server would refuse every request");
    }
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        logError("mcpServer.handle", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify(rpcError(null, -32603, "internal error")));
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
    // Listen-time failures rejected above; anything later must not go unhandled.
    server.on("error", (error) => logError("mcpServer.socket", error));
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const verdict = checkMcpRequest(
      { method: req.method, headers: req.headers },
      { token: this.opts.token(), requireAuth: this.opts.requireAuth() },
    );
    if (!verdict.ok) {
      this.opts.onRejected?.(verdict, { remote: req.socket.remoteAddress, origin: header(req.headers, "origin"), method: req.method });
      // Never any CORS headers: a browser must not be able to preflight or read anything here.
      res.writeHead(verdict.status, { "content-type": "application/json", connection: "close", ...verdict.headers });
      res.end(rejectionBody(verdict));
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(rpcError(null, RPC_REJECTED_CODE, `Payload Too Large: ${error.message}`)));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
      return;
    }
    if (!isRpcRequest(parsed) && !(Array.isArray(parsed) && parsed.length > 0 && parsed.every(isRpcRequest))) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(rpcError(null, -32600, "invalid request: expected a JSON-RPC object or a non-empty batch")));
      return;
    }
    const allowMutating = this.opts.allowMutating();
    // A batch of notifications yields nothing to send back.
    const out = Array.isArray(parsed)
      ? (await Promise.all(parsed.map((r) => dispatch(r, allowMutating)))).filter(Boolean)
      : await dispatch(parsed, allowMutating);
    if (!out || (Array.isArray(out) && !out.length)) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  }

  stop(): void {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.port = 0;
    server.close();
    // close() alone waits for keep-alive clients to go away; drop them now.
    server.closeAllConnections();
  }
}

function cfg() {
  const c = vscode.workspace.getConfiguration("yargix");
  return {
    enabled: c.get<boolean>("mcpServer.enabled", false),
    port: c.get<number>("mcpServer.port", 39273),
    allowMutating: c.get<boolean>("mcpServer.allowMutatingTools", false),
    requireAuth: c.get<boolean>("mcpServer.requireAuth", true),
  };
}

async function loadOrCreateToken(secrets: vscode.SecretStorage): Promise<string> {
  const existing = await secrets.get(TOKEN_SECRET_KEY);
  if (isPlausibleToken(existing)) return existing;
  const fresh = generateMcpToken();
  await secrets.store(TOKEN_SECRET_KEY, fresh);
  return fresh;
}

/** Register the MCP server: starts when enabled, follows the settings live. */
export function registerMcpServer(context: vscode.ExtensionContext): void {
  let token: string | undefined;
  let loading: Promise<string> | undefined;
  /** One load at a time, so a first-run start and a Copy Config cannot mint two different tokens. */
  const ensureToken = (): Promise<string> => {
    if (token) return Promise.resolve(token);
    loading ??= loadOrCreateToken(context.secrets)
      .then((loaded) => (token ??= loaded))
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };

  const COPY = "Copy Client Config";
  const configuredAddress = () => server.address || `http://127.0.0.1:${cfg().port}/mcp`;
  const copyClientConfig = async (): Promise<void> => {
    const { enabled, requireAuth } = cfg();
    const bearer = requireAuth ? await ensureToken() : undefined;
    await vscode.env.clipboard.writeText(clientConfigSnippet(configuredAddress(), bearer));
    const what = bearer ? "URL and bearer token" : "URL, no token required";
    const state = enabled ? "" : " The server is currently off (yargix.mcpServer.enabled).";
    vscode.window.showInformationMessage(`YargiX: MCP client config copied (${what}). Paste it into your MCP client's settings.${state}`);
  };

  const ledger = new RejectionLedger();
  // A token-less local client is most likely one configured before auth existed:
  // point at the fix once per session. Browsers never get this far (Origin fails first).
  let hintedAuth = false;
  const server = new McpServer({
    allowMutating: () => cfg().allowMutating,
    requireAuth: () => cfg().requireAuth,
    token: () => token,
    onRejected: (rejection, info) => {
      const { count, shouldLog } = ledger.note(rejection.reason);
      if (shouldLog) {
        logWarn("mcpServer.rejected", rejection.message, {
          reason: rejection.reason,
          status: rejection.status,
          count,
          method: info.method,
          remote: info.remote,
          origin: info.origin,
        });
      }
      if (rejection.reason === "auth" && !hintedAuth) {
        hintedAuth = true;
        void vscode.window
          .showInformationMessage("YargiX: an MCP client was refused because it did not send the server's bearer token. Update its config with the token.", COPY)
          .then((choice) => (choice ? copyClientConfig() : undefined));
      }
    },
  });

  let activePort: number | undefined;
  const sync = async (): Promise<void> => {
    const { enabled, port } = cfg();
    if (!enabled) {
      if (server.running) server.stop();
      activePort = undefined;
      return;
    }
    if (server.running && activePort === port) return;
    // Port changed under a running server: move it.
    if (server.running) server.stop();
    try {
      await ensureToken();
      await server.start(port);
      activePort = port;
      vscode.window.setStatusBarMessage(`YargiX MCP server on ${server.address}`, 4000);
    } catch (error) {
      logError("mcpServer.start", error);
      vscode.window.showErrorMessage(
        `YargiX: MCP server could not start on port ${port} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  // Serialize: a burst of setting changes must not race two starts.
  let chain: Promise<void> = Promise.resolve();
  const queueSync = () => {
    chain = chain.then(sync).catch((error) => logError("mcpServer.sync", error));
  };

  queueSync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yargix.mcpServer")) queueSync();
    }),
    vscode.commands.registerCommand("yargix.mcpServer.showAddress", async () => {
      if (!server.running) {
        vscode.window.showInformationMessage("YargiX: MCP server is off (enable yargix.mcpServer.enabled).");
        return;
      }
      const auth = cfg().requireAuth ? " — bearer token required" : " — no token required";
      const choice = await vscode.window.showInformationMessage(`YargiX MCP server: ${server.address}${auth}`, "Copy URL", COPY);
      if (choice === "Copy URL") await vscode.env.clipboard.writeText(server.address);
      if (choice === COPY) await copyClientConfig();
    }),
    vscode.commands.registerCommand("yargix.mcpServer.copyConfig", copyClientConfig),
    vscode.commands.registerCommand("yargix.mcpServer.rotateToken", async () => {
      // Let any in-flight first load settle first, so the rotation is the last write.
      await ensureToken();
      token = generateMcpToken();
      await context.secrets.store(TOKEN_SECRET_KEY, token);
      const choice = await vscode.window.showInformationMessage(
        "YargiX: MCP server token rotated. Clients still using the old token are rejected until they are updated.",
        COPY,
      );
      if (choice) await copyClientConfig();
    }),
    { dispose: () => server.stop() },
  );
}
