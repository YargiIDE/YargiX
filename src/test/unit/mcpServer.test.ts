/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The loopback MCP server end to end: a real `http.Server` on an ephemeral
 * port, real requests. The guard's unit tests prove each rule in isolation;
 * these prove the server actually enforces them on the wire, and that the
 * JSON-RPC layer behind them still works for a legitimate client.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";

import { McpServer, type McpServerOptions } from "../../integrations/mcpServer";
import { generateMcpToken, LATEST_PROTOCOL_VERSION, RPC_REJECTED_CODE, type McpRejection } from "../../integrations/mcpServerGuard";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(port: number, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: opts.method ?? "POST", headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

interface Harness {
  server: McpServer;
  port: number;
  token: string;
  rejections: McpRejection[];
  flags: { allowMutating: boolean; requireAuth: boolean };
  /** Headers a well-behaved authenticated client sends. */
  auth: Record<string, string>;
  rpc(payload: unknown, headers?: Record<string, string>): Promise<Res>;
}

async function withServer(fn: (h: Harness) => Promise<void>, init: Partial<Harness["flags"]> = {}): Promise<void> {
  const token = generateMcpToken();
  const flags = { allowMutating: false, requireAuth: true, ...init };
  const rejections: McpRejection[] = [];
  const opts: McpServerOptions = {
    allowMutating: () => flags.allowMutating,
    requireAuth: () => flags.requireAuth,
    token: () => token,
    onRejected: (r) => rejections.push(r),
  };
  const server = new McpServer(opts);
  await server.start(0);
  const port = server.listeningPort;
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };
  try {
    await fn({
      server,
      port,
      token,
      rejections,
      flags,
      auth,
      rpc: (payload, headers = {}) => send(port, { headers: { ...auth, ...headers }, body: JSON.stringify(payload) }),
    });
  } finally {
    server.stop();
  }
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

test("start binds an ephemeral loopback port and reports the /mcp address", async () => {
  await withServer(async (h) => {
    assert.equal(h.server.running, true);
    assert.ok(h.port > 0);
    assert.equal(h.server.address, `http://127.0.0.1:${h.port}/mcp`);
  });
});

test("initialize negotiates the protocol version and identifies the server", async () => {
  await withServer(async (h) => {
    const echoed = await h.rpc(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    assert.equal(echoed.status, 200);
    assert.match(echoed.headers["content-type"] ?? "", /application\/json/);
    const body = JSON.parse(echoed.body);
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, "2025-03-26");
    assert.equal(body.result.serverInfo.name, "yargix");
    assert.deepEqual(body.result.capabilities, { tools: {} });

    const future = await h.rpc(rpc("initialize", { protocolVersion: "2099-01-01" }, "x"));
    assert.equal(JSON.parse(future.body).result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(JSON.parse(future.body).id, "x");
  });
});

test("tools/list is read-only by default and follows the setting live", async () => {
  await withServer(async (h) => {
    const names = async () => (JSON.parse((await h.rpc(rpc("tools/list"))).body).result.tools as { name: string }[]).map((t) => t.name);
    const readOnly = await names();
    for (const expected of ["Read", "Grep", "Glob", "ListDir", "TodoRead"]) assert.ok(readOnly.includes(expected), expected);
    for (const hidden of ["Shell", "Write", "StrReplace", "Delete", "EditNotebook", "Task", "AskQuestion", "SwitchMode"]) {
      assert.ok(!readOnly.includes(hidden), `${hidden} must not be exposed read-only`);
    }
    h.flags.allowMutating = true;
    const mutating = await names();
    for (const expected of ["Shell", "Write", "StrReplace"]) assert.ok(mutating.includes(expected), expected);
    // Agent-coordination tools stay hidden even then.
    for (const hidden of ["Task", "AskQuestion", "SwitchMode"]) assert.ok(!mutating.includes(hidden), hidden);
  });
});

test("tools/call runs an exposed tool and reports a hidden one in-band", async () => {
  await withServer(async (h) => {
    const ok = await h.rpc(rpc("tools/call", { name: "TodoRead", arguments: {} }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).result, { content: [{ type: "text", text: "(no todos)" }] });

    const hidden = await h.rpc(rpc("tools/call", { name: "Shell", arguments: { command: "echo hi" } }));
    assert.equal(hidden.status, 200);
    const result = JSON.parse(hidden.body).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not exposed/);

    const unknown = await h.rpc(rpc("tools/call", { name: "NoSuchTool" }));
    assert.equal(JSON.parse(unknown.body).result.isError, true);
  });
});

test("ping, unknown methods, notifications, and batches follow JSON-RPC", async () => {
  await withServer(async (h) => {
    assert.deepEqual(JSON.parse((await h.rpc(rpc("ping"))).body), { jsonrpc: "2.0", id: 1, result: {} });

    const unknown = JSON.parse((await h.rpc(rpc("resources/list"))).body);
    assert.equal(unknown.error.code, -32601);

    const notification = await h.rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notification.status, 202);
    assert.equal(notification.body, "");

    const batch = await h.rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }, rpc("ping", undefined, 7)]);
    assert.equal(batch.status, 200);
    assert.deepEqual(JSON.parse(batch.body), [{ jsonrpc: "2.0", id: 7, result: {} }]);

    const garbage = await send(h.port, { headers: h.auth, body: "{not json" });
    assert.equal(garbage.status, 400);
    assert.equal(JSON.parse(garbage.body).error.code, -32700);

    // Valid JSON that is not a JSON-RPC message is an invalid request, not a 500.
    for (const body of ["null", "42", '"ping"', "[]", "[1]", "[{}, null]"]) {
      const invalid = await send(h.port, { headers: h.auth, body });
      assert.equal(invalid.status, 400, body);
      assert.equal(JSON.parse(invalid.body).error.code, -32600, body);
    }
  });
});

test("a request without the bearer token is 401 and never reaches JSON-RPC", async () => {
  await withServer(async (h) => {
    const res = await send(h.port, { headers: { "content-type": "application/json" }, body: JSON.stringify(rpc("tools/list")) });
    assert.equal(res.status, 401);
    assert.match(res.headers["www-authenticate"] ?? "", /^Bearer realm="YargiX MCP"/);
    assert.equal(res.headers.connection, "close");
    const body = JSON.parse(res.body);
    assert.equal(body.id, null);
    assert.equal(body.error.code, RPC_REJECTED_CODE);
    assert.match(body.error.message, /Authorization: Bearer/);

    const wrong = await send(h.port, { headers: { ...h.auth, authorization: `Bearer ${generateMcpToken()}` }, body: JSON.stringify(rpc("ping")) });
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers["www-authenticate"] ?? "", /invalid_token/);

    assert.deepEqual(h.rejections.map((r) => r.reason), ["auth", "auth"]);
  });
});

test("a browser's cross-origin simple POST is refused with no CORS headers", async () => {
  await withServer(async (h) => {
    const res = await send(h.port, {
      headers: { origin: "https://attacker.example", "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(rpc("tools/call", { name: "Read", arguments: { path: "/etc/passwd" } })),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(h.rejections[0]?.reason, "origin");

    // The CORS preflight a page would need for application/json also fails.
    const preflight = await send(h.port, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.allow, "POST");
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    assert.equal(preflight.headers["access-control-allow-methods"], undefined);
  });
});

test("a rebound Host header is refused while loopback origins are accepted", async () => {
  await withServer(async (h) => {
    const rebound = await send(h.port, { headers: { ...h.auth, host: "attacker.example:39273" }, body: JSON.stringify(rpc("ping")) });
    assert.equal(rebound.status, 403);
    assert.equal(h.rejections[0]?.reason, "host");

    const local = await h.rpc(rpc("ping"), { origin: `http://localhost:${h.port}` });
    assert.equal(local.status, 200);
  });
});

test("GET and text/plain from a local client are refused with the right status", async () => {
  await withServer(async (h) => {
    const get = await send(h.port, { method: "GET", headers: { authorization: `Bearer ${h.token}` } });
    assert.equal(get.status, 405);

    const plain = await send(h.port, { headers: { ...h.auth, "content-type": "text/plain" }, body: JSON.stringify(rpc("ping")) });
    assert.equal(plain.status, 415);

    const version = await h.rpc(rpc("ping"), { "mcp-protocol-version": "1999-01-01" });
    assert.equal(version.status, 400);

    assert.deepEqual(h.rejections.map((r) => r.reason), ["method", "content-type", "protocol-version"]);
  });
});

test("requireAuth off admits token-less loopback clients but still refuses browsers", async () => {
  await withServer(
    async (h) => {
      const open = await send(h.port, { headers: { "content-type": "application/json" }, body: JSON.stringify(rpc("ping")) });
      assert.equal(open.status, 200);
      const page = await send(h.port, { headers: { origin: "https://attacker.example", "content-type": "text/plain" }, body: "{}" });
      assert.equal(page.status, 403);
      // Flipping the setting on takes effect on the next request, no restart.
      h.flags.requireAuth = true;
      const now = await send(h.port, { headers: { "content-type": "application/json" }, body: JSON.stringify(rpc("ping")) });
      assert.equal(now.status, 401);
    },
    { requireAuth: false },
  );
});

test("an oversized body is drained and answered with 413", async () => {
  await withServer(async (h) => {
    const huge = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    const res = await send(h.port, { headers: { ...h.auth, "content-length": String(huge.length) }, body: huge });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).error.code, RPC_REJECTED_CODE);
    // The server is still healthy afterwards.
    assert.equal((await h.rpc(rpc("ping"))).status, 200);
  });
});

test("start is idempotent under concurrent calls and stop closes the port", async () => {
  const token = generateMcpToken();
  const server = new McpServer({ allowMutating: () => false, requireAuth: () => true, token: () => token });
  const [a, b] = await Promise.all([server.start(0), server.start(0)]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  const port = server.listeningPort;
  assert.ok(port > 0);
  await server.start(0);
  assert.equal(server.listeningPort, port, "a second start must not rebind");

  server.stop();
  assert.equal(server.running, false);
  assert.equal(server.address, "");
  await assert.rejects(send(port, { headers: { "content-type": "application/json" }, body: "{}" }));
  // Stopping twice is harmless.
  server.stop();
});

test("a server that requires auth refuses to start without a token", async () => {
  let token: string | undefined;
  const server = new McpServer({ allowMutating: () => false, requireAuth: () => true, token: () => token });
  await assert.rejects(server.start(0), /no bearer token/);
  assert.equal(server.running, false);
  // The failed attempt did not wedge it: once a token exists the same instance starts.
  token = generateMcpToken();
  await server.start(0);
  assert.equal(server.running, true);
  server.stop();
});
