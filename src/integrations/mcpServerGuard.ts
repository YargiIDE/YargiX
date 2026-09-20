/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Request gate for the loopback MCP server.
 *
 * Binding to 127.0.0.1 keeps the network out but not the browser. A web page
 * can `fetch()` a loopback URL cross-origin, and a POST with a "simple"
 * content type (`text/plain`) needs no CORS preflight, so the request is
 * delivered even though the page never sees the response. DNS rebinding turns
 * the same trick into a same-origin call. Every other local process (or user
 * on a shared machine) can simply connect.
 *
 * Three independent layers close that, in the order a request meets them:
 *   1. `Host` and `Origin` must be loopback — stops browsers and rebinding.
 *   2. A bearer token — stops everything that does not hold it.
 *   3. `Content-Type: application/json` — a browser cannot send it without a
 *      preflight, and the server never answers preflights.
 *
 * Pure: no `vscode` import, so it runs under plain Node in the unit tests.
 */

import { randomBytes, timingSafeEqual } from "crypto";

export type HeadersLike = Record<string, string | string[] | undefined>;

export interface McpGuardOptions {
  /** Bearer token every request must present; only consulted when `requireAuth` is true. */
  token: string | undefined;
  requireAuth: boolean;
}

export type McpRejectReason = "method" | "host" | "origin" | "auth" | "content-type" | "protocol-version";

export interface McpRejection {
  ok: false;
  status: number;
  reason: McpRejectReason;
  /** Human-readable explanation, also sent back as the JSON-RPC error message. */
  message: string;
  /** Extra response headers (e.g. `WWW-Authenticate`, `Allow`). */
  headers: Record<string, string>;
}

export type McpGuardVerdict = { ok: true } | McpRejection;

/** Protocol revisions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC error code the MCP SDKs use for HTTP-level (4xx) rejections. */
export const RPC_REJECTED_CODE = -32000;

const TOKEN_BYTES = 32;
/** base64url of 32 bytes: 43 chars from [A-Za-z0-9_-], no padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Exact Host forms a loopback client produces; a hostname regex, not a URL parse, so `user@host` tricks cannot slip past. */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const HINT = "Run 'YargiX: Copy MCP Client Config' in VS Code for a ready-made client entry.";

export function generateMcpToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** True when `value` looks like a token this module generated (so a corrupt secret is regenerated, not trusted). */
export function isPlausibleToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/** Constant-time comparison; a length mismatch still burns a comparison so it is not a faster path. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** First value of a header, case-insensitively, or undefined. */
export function header(headers: HeadersLike, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return undefined;
  const v = headers[key];
  return Array.isArray(v) ? v[0] : v;
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
  return !!host && LOOPBACK_HOST.test(host.trim());
}

/**
 * A browser `Origin` is either the literal `null` or a serialized origin
 * (`scheme://host[:port]`, nothing else). Re-serializing through URL and
 * demanding equality rejects userinfo, paths, and odd casing in one go.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const value = origin.trim();
  if (value === "null") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

function parseBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  return m ? m[1] : undefined;
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function reject(status: number, reason: McpRejectReason, message: string, headers: Record<string, string> = {}): McpRejection {
  return { ok: false, status, reason, message, headers };
}

/** Decide whether an incoming HTTP request may reach the JSON-RPC layer. */
export function checkMcpRequest(
  req: { method?: string; headers: HeadersLike },
  opts: McpGuardOptions,
): McpGuardVerdict {
  const method = (req.method ?? "").toUpperCase();
  if (method !== "POST") {
    // Includes OPTIONS: a CORS preflight fails here, so no browser can be granted access.
    return reject(405, "method", "Method Not Allowed: the MCP endpoint accepts POST only.", { allow: "POST" });
  }

  const host = header(req.headers, "host");
  if (!isLoopbackHostHeader(host)) {
    return reject(403, "host", `Forbidden: Host header must be a loopback address (got ${host ? JSON.stringify(host) : "none"}).`);
  }

  const origin = header(req.headers, "origin");
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return reject(403, "origin", `Forbidden: Origin ${JSON.stringify(origin)} may not use this server.`);
  }

  if (opts.requireAuth) {
    const realm = 'Bearer realm="YargiX MCP"';
    if (!opts.token) {
      // Fail closed: a server that wants auth but has no token accepts nobody.
      return reject(401, "auth", "Unauthorized: the server has no bearer token configured; restart the MCP server.", { "www-authenticate": realm });
    }
    const presented = parseBearer(header(req.headers, "authorization"));
    if (presented === undefined) {
      return reject(401, "auth", `Unauthorized: send 'Authorization: Bearer <token>'. ${HINT}`, { "www-authenticate": realm });
    }
    if (!tokenMatches(presented, opts.token)) {
      return reject(401, "auth", `Unauthorized: bearer token rejected. ${HINT}`, {
        "www-authenticate": `${realm}, error="invalid_token"`,
      });
    }
  }

  const type = mediaType(header(req.headers, "content-type"));
  if (type !== "application/json") {
    return reject(415, "content-type", `Unsupported Media Type: Content-Type must be application/json (got ${type ? JSON.stringify(type) : "none"}).`);
  }

  const version = header(req.headers, "mcp-protocol-version");
  if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version.trim())) {
    return reject(400, "protocol-version", `Bad Request: unsupported MCP-Protocol-Version ${JSON.stringify(version)}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`);
  }

  return { ok: true };
}

/** Echo the client's revision when we speak it, otherwise offer our newest and let the client decide. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/** JSON-RPC error body for a rejected request (id is null: the body was never parsed). */
export function rejectionBody(rejection: McpRejection): string {
  return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: RPC_REJECTED_CODE, message: rejection.message } });
}

/** `mcpServers` entry most MCP clients accept verbatim; the token rides in the Authorization header. */
export function clientConfigSnippet(address: string, token: string | undefined): string {
  const server: Record<string, unknown> = { url: address };
  if (token) server.headers = { Authorization: `Bearer ${token}` };
  return JSON.stringify({ mcpServers: { yargix: server } }, null, 2);
}

/**
 * Keeps rejection logging useful under a flood: the first few of each reason
 * are logged verbatim, then only every `every`-th, with the running count.
 */
export class RejectionLedger {
  private counts = new Map<McpRejectReason, number>();

  constructor(private readonly verbose = 3, private readonly every = 50) {}

  note(reason: McpRejectReason): { count: number; shouldLog: boolean } {
    const count = (this.counts.get(reason) ?? 0) + 1;
    this.counts.set(reason, count);
    return { count, shouldLog: count <= this.verbose || count % this.every === 0 };
  }

  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }
}
