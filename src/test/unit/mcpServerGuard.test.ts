/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * The request gate in front of the loopback MCP server. Each check here is a
 * concrete attack the server must refuse: a cross-origin "simple" POST from a
 * web page, DNS rebinding, a local process without the token, a CORS preflight.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkMcpRequest,
  clientConfigSnippet,
  generateMcpToken,
  header,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  isPlausibleToken,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  rejectionBody,
  RejectionLedger,
  RPC_REJECTED_CODE,
  SUPPORTED_PROTOCOL_VERSIONS,
  tokenMatches,
  type HeadersLike,
  type McpGuardVerdict,
} from "../../integrations/mcpServerGuard";

const TOKEN = generateMcpToken();

/** A well-formed request from a legitimate local MCP client. */
function good(overrides: HeadersLike = {}, method = "POST") {
  const headers: HeadersLike = {
    host: "127.0.0.1:39273",
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
    ...overrides,
  };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return { method, headers };
}

function rejected(v: McpGuardVerdict) {
  assert.equal(v.ok, false, "expected the request to be rejected");
  if (v.ok) throw new Error("unreachable");
  return v;
}

const AUTH = { token: TOKEN, requireAuth: true };

test("tokens are 43-char base64url, unique, and recognised as plausible", () => {
  const a = generateMcpToken();
  const b = generateMcpToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(isPlausibleToken(a), true);
  for (const bad of ["", "short", undefined, null, 42, `${a}=`, a.slice(0, 42), "x".repeat(43) + "!"]) {
    assert.equal(isPlausibleToken(bad), false, `should not accept ${JSON.stringify(bad)}`);
  }
  // A '!' is outside base64url even at the right length.
  assert.equal(isPlausibleToken("!".repeat(43)), false);
});

test("tokenMatches: equal only, regardless of length mismatch direction", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN.slice(0, -1) + (TOKEN.endsWith("A") ? "B" : "A"), TOKEN), false);
  assert.equal(tokenMatches(TOKEN.slice(1), TOKEN), false);
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(tokenMatches("", TOKEN), false);
});

test("header lookup is case-insensitive and takes the first of repeated values", () => {
  assert.equal(header({ "content-type": "a" }, "Content-Type"), "a");
  assert.equal(header({ "Content-Type": "a" }, "content-type"), "a");
  assert.equal(header({ origin: ["x", "y"] }, "origin"), "x");
  assert.equal(header({}, "origin"), undefined);
});

test("a well-formed authenticated loopback request passes", () => {
  assert.deepEqual(checkMcpRequest(good(), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ "content-type": "application/json; charset=utf-8" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ "Content-Type": "Application/JSON", "content-type": undefined }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ authorization: `bearer   ${TOKEN}` }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ host: "localhost:39273" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ host: "[::1]:39273" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ host: "LOCALHOST" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ origin: "http://localhost:5173" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ origin: "https://127.0.0.1" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ origin: "http://[::1]:3000" }), AUTH), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ "mcp-protocol-version": "2025-03-26" }), AUTH), { ok: true });
});

test("only POST is allowed; a CORS preflight (OPTIONS) is refused with Allow: POST", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "post-ish", ""]) {
    const v = rejected(checkMcpRequest(good({}, method), AUTH));
    assert.equal(v.status, 405, method);
    assert.equal(v.reason, "method");
    assert.equal(v.headers.allow, "POST");
  }
  // Lower-case method names are normalised, not refused.
  assert.deepEqual(checkMcpRequest(good({}, "post"), AUTH), { ok: true });
});

test("Host must be a loopback authority (DNS rebinding defence)", () => {
  for (const host of ["evil.example:39273", "127.0.0.1.evil.example", "localhost.evil.example:39273", "evil.example@127.0.0.1:39273", "127.0.0.2:39273", "0.0.0.0:39273", "192.168.1.5:39273", "::1", "localhost:notaport", " "]) {
    const v = rejected(checkMcpRequest(good({ host }), AUTH));
    assert.equal(v.status, 403, host);
    assert.equal(v.reason, "host", host);
  }
  const missing = rejected(checkMcpRequest(good({ host: undefined }), AUTH));
  assert.equal(missing.status, 403);
  assert.equal(missing.reason, "host");
  assert.match(missing.message, /none/);
});

test("isLoopbackHostHeader accepts exactly the three loopback names with an optional port", () => {
  for (const ok of ["localhost", "localhost:1", "127.0.0.1:65535", "[::1]", "[::1]:8080", "Localhost:39273", " 127.0.0.1:39273 "]) {
    assert.equal(isLoopbackHostHeader(ok), true, ok);
  }
  for (const bad of [undefined, "", "127.0.0.1:", "localhost:123456", "http://localhost", "localhost/mcp", "localhost:39273/mcp"]) {
    assert.equal(isLoopbackHostHeader(bad), false, String(bad));
  }
});

test("a non-loopback Origin is refused even with a valid token", () => {
  for (const origin of ["https://evil.example", "http://evil.example:39273", "null", "http://localhost.evil.example", "http://evil.example@localhost", "vscode-webview://abc", "chrome-extension://abcdef", "file://", "http://localhost/", "HTTP://LOCALHOST", "ftp://localhost", "localhost", ""]) {
    const v = rejected(checkMcpRequest(good({ origin }), AUTH));
    assert.equal(v.status, 403, origin);
    assert.equal(v.reason, "origin", origin);
  }
});

test("isLoopbackOrigin demands a serialized http(s) origin with a loopback host", () => {
  for (const ok of ["http://localhost", "http://localhost:3000", "https://127.0.0.1:8443", "http://[::1]", "http://[::1]:5173"]) {
    assert.equal(isLoopbackOrigin(ok), true, ok);
  }
  for (const bad of [undefined, "", "null", "http://localhost:80", "http://localhost/path", "http://user@localhost", "ws://localhost", "http://127.0.0.2"]) {
    assert.equal(isLoopbackOrigin(bad), false, String(bad));
  }
});

test("the browser 'simple POST' attack is stopped at the Origin layer, before auth", () => {
  // What `fetch(url, { method: "POST", mode: "no-cors", body })` from a page produces.
  const page = good({ origin: "https://attacker.example", "content-type": "text/plain;charset=UTF-8", authorization: undefined });
  const v = rejected(checkMcpRequest(page, AUTH));
  assert.equal(v.status, 403);
  assert.equal(v.reason, "origin");
  // Even with auth disabled the page gets nowhere.
  const open = rejected(checkMcpRequest(page, { token: undefined, requireAuth: false }));
  assert.equal(open.status, 403);
  assert.equal(open.reason, "origin");
});

test("missing or wrong bearer token is 401 with a WWW-Authenticate challenge", () => {
  const missing = rejected(checkMcpRequest(good({ authorization: undefined }), AUTH));
  assert.equal(missing.status, 401);
  assert.equal(missing.reason, "auth");
  assert.equal(missing.headers["www-authenticate"], 'Bearer realm="YargiX MCP"');
  assert.match(missing.message, /Copy MCP Client Config/);

  for (const bad of [`Bearer ${generateMcpToken()}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, "Bearer", "Bearer ", `Basic ${Buffer.from(`u:${TOKEN}`).toString("base64")}`, TOKEN, `Token ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
    const v = rejected(checkMcpRequest(good({ authorization: bad }), AUTH));
    assert.equal(v.status, 401, bad);
    assert.equal(v.reason, "auth", bad);
    assert.match(v.headers["www-authenticate"], /^Bearer realm="YargiX MCP"/, bad);
  }
  const wrong = rejected(checkMcpRequest(good({ authorization: `Bearer ${generateMcpToken()}` }), AUTH));
  assert.match(wrong.headers["www-authenticate"], /error="invalid_token"/);
  // The token itself never appears in a message a log might carry.
  assert.equal(wrong.message.includes(TOKEN), false);
});

test("auth required but no token configured fails closed", () => {
  const v = rejected(checkMcpRequest(good(), { token: undefined, requireAuth: true }));
  assert.equal(v.status, 401);
  assert.equal(v.reason, "auth");
  const empty = rejected(checkMcpRequest(good({ authorization: "Bearer " }), { token: "", requireAuth: true }));
  assert.equal(empty.status, 401);
});

test("with requireAuth off the token is ignored but Host, Origin and Content-Type still apply", () => {
  const open = { token: TOKEN, requireAuth: false };
  assert.deepEqual(checkMcpRequest(good({ authorization: undefined }), open), { ok: true });
  assert.deepEqual(checkMcpRequest(good({ authorization: "Bearer wrong" }), open), { ok: true });
  assert.equal(rejected(checkMcpRequest(good({ host: "evil.example" }), open)).reason, "host");
  assert.equal(rejected(checkMcpRequest(good({ origin: "https://evil.example" }), open)).reason, "origin");
  assert.equal(rejected(checkMcpRequest(good({ "content-type": "text/plain" }), open)).reason, "content-type");
});

test("Content-Type must be application/json (CORS-safelisted types are exactly what a page can send)", () => {
  for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json-rpc", "application/octet-stream", "json"]) {
    const v = rejected(checkMcpRequest(good({ "content-type": type }), AUTH));
    assert.equal(v.status, 415, type);
    assert.equal(v.reason, "content-type", type);
  }
  const missing = rejected(checkMcpRequest(good({ "content-type": undefined }), AUTH));
  assert.equal(missing.status, 415);
  assert.match(missing.message, /none/);
});

test("an unsupported MCP-Protocol-Version header is a 400, a supported one passes", () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.deepEqual(checkMcpRequest(good({ "mcp-protocol-version": version }), AUTH), { ok: true }, version);
  }
  for (const version of ["1999-01-01", "latest", "", "2025-06-18-draft"]) {
    const v = rejected(checkMcpRequest(good({ "mcp-protocol-version": version }), AUTH));
    assert.equal(v.status, 400, version);
    assert.equal(v.reason, "protocol-version", version);
  }
});

test("checks run in a fixed order so the response never reveals more than it must", () => {
  // Everything wrong at once: method wins.
  const all = good({ host: "evil.example", origin: "https://evil.example", authorization: undefined, "content-type": "text/plain" }, "GET");
  assert.equal(rejected(checkMcpRequest(all, AUTH)).reason, "method");
  // POST, everything else wrong: host wins over origin.
  all.method = "POST";
  assert.equal(rejected(checkMcpRequest(all, AUTH)).reason, "host");
  all.headers.host = "127.0.0.1:39273";
  assert.equal(rejected(checkMcpRequest(all, AUTH)).reason, "origin");
  delete all.headers.origin;
  assert.equal(rejected(checkMcpRequest(all, AUTH)).reason, "auth");
  all.headers.authorization = `Bearer ${TOKEN}`;
  assert.equal(rejected(checkMcpRequest(all, AUTH)).reason, "content-type");
  all.headers["content-type"] = "application/json";
  assert.deepEqual(checkMcpRequest(all, AUTH), { ok: true });
});

test("negotiateProtocolVersion echoes a supported revision and otherwise offers the newest", () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.equal(negotiateProtocolVersion(v), v);
  assert.equal(negotiateProtocolVersion("2099-01-01"), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(42), LATEST_PROTOCOL_VERSION);
  assert.equal(LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS[0]);
  // Newest first, so the fallback really is the newest.
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort().reverse(), SUPPORTED_PROTOCOL_VERSIONS);
});

test("rejectionBody is a JSON-RPC error with a null id and the SDK's 4xx code", () => {
  const v = rejected(checkMcpRequest(good({ authorization: undefined }), AUTH));
  const body = JSON.parse(rejectionBody(v));
  assert.deepEqual(body, { jsonrpc: "2.0", id: null, error: { code: RPC_REJECTED_CODE, message: v.message } });
});

test("clientConfigSnippet is a paste-ready mcpServers entry, headers only when there is a token", () => {
  const withToken = JSON.parse(clientConfigSnippet("http://127.0.0.1:39273/mcp", TOKEN));
  assert.deepEqual(withToken, {
    mcpServers: { yargix: { url: "http://127.0.0.1:39273/mcp", headers: { Authorization: `Bearer ${TOKEN}` } } },
  });
  const open = JSON.parse(clientConfigSnippet("http://127.0.0.1:4000/mcp", undefined));
  assert.deepEqual(open, { mcpServers: { yargix: { url: "http://127.0.0.1:4000/mcp" } } });
  // Pretty-printed so it reads well in a settings file.
  assert.ok(clientConfigSnippet("http://127.0.0.1:1/mcp", TOKEN).includes("\n  "));
});

test("RejectionLedger logs the first few of each reason, then every 50th", () => {
  const ledger = new RejectionLedger();
  const logged: number[] = [];
  for (let i = 0; i < 120; i++) {
    const { count, shouldLog } = ledger.note("auth");
    assert.equal(count, i + 1);
    if (shouldLog) logged.push(count);
  }
  assert.deepEqual(logged, [1, 2, 3, 50, 100]);
  // Reasons are counted independently.
  assert.deepEqual(ledger.note("origin"), { count: 1, shouldLog: true });
  assert.equal(ledger.total(), 121);
});
