/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Browser control over the Chrome DevTools Protocol.
 *
 * The agent can write UI code but not see whether it works. This drives a real
 * Chrome/Edge — the one already installed — so it can open the dev server, take
 * a screenshot the model can actually look at, read console errors, and click
 * through a flow.
 *
 * CDP speaks WebSocket, and the extension host runs a Node version without a
 * global WebSocket, so a minimal RFC 6455 client lives here rather than pulling
 * in a browser-automation dependency and its ~150 MB of bundled binaries.
 */

import * as http from "http";
import * as net from "net";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import { logError } from "../logging";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** CDP screenshots are big; refuse anything absurd rather than blowing up memory. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------- websocket

type MessageHandler = (data: string) => void;

/** Minimal client-side WebSocket (text frames only — CDP never sends binary). */
export class MiniWebSocket {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private handlers: MessageHandler[] = [];
  private closed = false;
  private onClose: (() => void) | undefined;

  static async connect(url: string, timeoutMs = 10_000): Promise<MiniWebSocket> {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const expected = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });
      const fail = (e: Error) => {
        req.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error("websocket handshake timed out")), timeoutMs);

      req.on("upgrade", (res, socket) => {
        clearTimeout(timer);
        if (res.headers["sec-websocket-accept"] !== expected) {
          socket.destroy();
          reject(new Error("websocket handshake rejected"));
          return;
        }
        const ws = new MiniWebSocket();
        ws.attach(socket);
        resolve(ws);
      });
      req.on("response", (res) => {
        clearTimeout(timer);
        fail(new Error(`websocket upgrade failed: HTTP ${res.statusCode}`));
      });
      req.on("error", (e) => {
        clearTimeout(timer);
        fail(e instanceof Error ? e : new Error(String(e)));
      });
      req.end();
    });
  }

  private attach(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => {
      this.closed = true;
      this.onClose?.();
    });
    socket.on("error", () => {
      this.closed = true;
      this.onClose?.();
    });
  }

  onMessage(fn: MessageHandler): void {
    this.handlers.push(fn);
  }
  onDisconnect(fn: () => void): void {
    this.onClose = fn;
  }
  get isClosed(): boolean {
    return this.closed;
  }

  /** Pull every complete frame out of the read buffer. */
  private drain(): void {
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.sendFrame(frame.payload, 0xa); // pong
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        const text = frame.payload.toString("utf8");
        for (const fn of [...this.handlers]) fn(text);
      }
    }
  }

  send(text: string): void {
    this.sendFrame(Buffer.from(text, "utf8"), 0x1);
  }

  private sendFrame(payload: Buffer, opcode: number): void {
    if (!this.socket || this.closed) return;
    this.socket.write(encodeFrame(payload, opcode));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sendFrame(Buffer.alloc(0), 0x8);
      this.socket?.end();
    } catch {
      // already gone
    }
  }
}

/** Encode one masked client frame (clients MUST mask, per RFC 6455). */
export function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  if (len < 126) head.push(0x80 | len);
  else if (len < 65536) head.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  /** Bytes consumed from the input buffer. */
  consumed: number;
}

/** Decode one frame, or undefined when the buffer does not hold a whole one. */
export function decodeFrame(buf: Buffer): DecodedFrame | undefined {
  if (buf.length < 2) return undefined;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return undefined;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return undefined;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error("websocket frame too large");
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_FRAME_BYTES) throw new Error("websocket frame too large");
  let mask: Buffer | undefined;
  if (masked) {
    if (buf.length < offset + 4) return undefined;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return undefined;
  const raw = buf.subarray(offset, offset + len);
  const payload = mask ? Buffer.from(raw.map((b, i) => b ^ mask![i % 4])) : Buffer.from(raw);
  return { opcode, payload, consumed: offset + len };
}

// ------------------------------------------------------------ browser lookup

/** Candidate Chrome/Edge executables, most preferred first. */
export function browserCandidates(platform = process.platform): string[] {
  if (platform === "win32") {
    // Fall back to the well-known install roots so a Linux/mac CI host can
    // still enumerate Windows candidates (and so a stripped-down Windows
    // environment without those variables is not empty-handed).
    const roots = [
      process.env["PROGRAMFILES"] || "C:\\Program Files",
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      process.env["LOCALAPPDATA"] || "C:\\Users\\Default\\AppData\\Local",
    ];
    const rel = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe",
    ];
    return roots.flatMap((r) => rel.map((x) => path.join(r, x)));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function findBrowser(explicit?: string): string | undefined {
  if (explicit && fs.existsSync(explicit)) return explicit;
  return browserCandidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function getJson<T>(port: number, route: string, timeoutMs = 1000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: route, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// ------------------------------------------------------------- cdp session

export interface ConsoleEntry {
  level: string;
  text: string;
  at: number;
}

/** One launched browser plus its CDP connection. */
class BrowserSession {
  private proc: ChildProcess | undefined;
  private ws: MiniWebSocket | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private console: ConsoleEntry[] = [];
  private profileDir: string | undefined;

  get running(): boolean {
    return !!this.ws && !this.ws.isClosed;
  }

  /** Console output since the page was opened (most recent last). */
  consoleEntries(): ConsoleEntry[] {
    return [...this.console];
  }
  clearConsole(): void {
    this.console = [];
  }

  async ensure(executablePath?: string, headless = true): Promise<void> {
    if (this.running) return;
    this.dispose();

    const exe = findBrowser(executablePath);
    if (!exe) {
      throw new Error(
        "no Chrome/Edge/Chromium found. Install one, or set yargix.browser.executablePath to its full path.",
      );
    }
    const port = await freePort();
    // A throwaway profile keeps the user's real browser data untouched.
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "yargix-browser-"));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "about:blank",
    ];
    if (headless) args.unshift("--headless=new");

    this.proc = spawn(exe, args, { stdio: "ignore", detached: false });
    this.proc.on("exit", () => {
      this.proc = undefined;
    });

    // The debugging endpoint is not up the instant the process starts.
    let wsUrl: string | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const info = await getJson<{ webSocketDebuggerUrl?: string }>(port, "/json/version");
        if (info.webSocketDebuggerUrl) {
          wsUrl = info.webSocketDebuggerUrl;
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!wsUrl) {
      this.dispose();
      throw new Error("browser started but its debugging endpoint never came up");
    }

    // Attach to the page target rather than the browser target, so Page/Runtime work.
    const targets = await getJson<{ id: string; type: string; webSocketDebuggerUrl?: string }[]>(port, "/json/list");
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    this.ws = await MiniWebSocket.connect(page?.webSocketDebuggerUrl ?? wsUrl);
    this.ws.onMessage((raw) => this.receive(raw));
    this.ws.onDisconnect(() => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("browser disconnected"));
      }
      this.pending.clear();
    });

    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
  }

  private receive(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
      return;
    }
    // Console and uncaught errors are the whole point of driving a browser.
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params?.args ?? [])
        .map((a: any) => a?.value ?? a?.description ?? a?.unserializableValue ?? "")
        .join(" ");
      this.pushConsole(msg.params?.type ?? "log", text);
    } else if (msg.method === "Log.entryAdded") {
      this.pushConsole(msg.params?.entry?.level ?? "info", msg.params?.entry?.text ?? "");
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      this.pushConsole("error", d?.exception?.description || d?.text || "uncaught exception");
    }
  }

  private pushConsole(level: string, text: string): void {
    if (!text) return;
    this.console.push({ level, text: text.slice(0, 2000), at: Date.now() });
    if (this.console.length > 200) this.console.shift();
  }

  /** Send one CDP command and await its result. */
  async send<T = any>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.isClosed) throw new Error("browser is not open");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  dispose(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("browser closed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
    this.proc = undefined;
    if (this.profileDir) {
      const dir = this.profileDir;
      this.profileDir = undefined;
      // Best-effort: the browser may still be releasing file handles.
      setTimeout(() => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          logError("browser.cleanup", error);
        }
      }, 1500);
    }
  }
}

export const browserSession = new BrowserSession();
