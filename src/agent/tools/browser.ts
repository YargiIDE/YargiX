/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { defineTool } from "./types";
import { browserSession } from "../../integrations/browser";

/** Screenshots go to the model as an image, so keep them a sane size. */
const VIEWPORT = { width: 1280, height: 800 };

function cfg() {
  const c = vscode.workspace.getConfiguration("yargix");
  return {
    executablePath: c.get<string>("browser.executablePath", "") || undefined,
    headless: c.get<boolean>("browser.headless", true),
  };
}

/** Only http(s) and localhost — never file:// or chrome:// from a tool call. */
function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid url: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported protocol "${u.protocol}" — only http and https are allowed`);
  }
  return u.toString();
}

function formatConsole(limit = 30): string {
  const entries = browserSession.consoleEntries().slice(-limit);
  if (!entries.length) return "(console empty)";
  return entries.map((e) => `[${e.level}] ${e.text}`).join("\n");
}

/** Wait for the page to settle after a navigation or interaction. */
async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function screenshot(): Promise<{ mime: string; base64: string }> {
  const res = await browserSession.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  return { mime: "image/png", base64: res.data };
}

export const browserTool = defineTool("Browser", true, async (input) => {
  const action = String(input?.action ?? "").trim().toLowerCase();
  const { executablePath, headless } = cfg();

  try {
    if (action === "close") {
      browserSession.dispose();
      return { output: "browser closed" };
    }

    await browserSession.ensure(executablePath, headless);
    await browserSession.send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => { /* older targets ignore this */ });

    switch (action) {
      case "open": {
        const url = checkUrl(String(input?.url ?? ""));
        browserSession.clearConsole();
        await browserSession.send("Page.navigate", { url });
        await settle(Number(input?.wait_ms) || 1200);
        const shot = await screenshot();
        return {
          output: `opened ${url}\n\nconsole:\n${formatConsole()}`,
          image: shot,
        };
      }

      case "screenshot": {
        const shot = await screenshot();
        return { output: "screenshot captured", image: shot };
      }

      case "console": {
        return { output: formatConsole(Number(input?.limit) || 50) };
      }

      case "click": {
        const selector = String(input?.selector ?? "").trim();
        if (!selector) throw new Error("click needs a `selector`");
        // Resolve the element's centre in the page, then dispatch a real click
        // there — synthetic .click() misses handlers bound to pointer events.
        const found = await browserSession.send<{ result: { value: unknown } }>("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`,
          returnByValue: true,
        });
        const point = found?.result?.value as { x: number; y: number } | null;
        if (!point) throw new Error(`no element matched ${selector}`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await browserSession.send("Input.dispatchMouseEvent", {
            type,
            x: Math.round(point.x),
            y: Math.round(point.y),
            button: "left",
            clickCount: 1,
          });
        }
        await settle(Number(input?.wait_ms) || 600);
        const shot = await screenshot();
        return { output: `clicked ${selector}\n\nconsole:\n${formatConsole()}`, image: shot };
      }

      case "type": {
        const text = String(input?.text ?? "");
        if (!text) throw new Error("type needs `text`");
        const selector = String(input?.selector ?? "").trim();
        if (selector) {
          const ok = await browserSession.send<{ result: { value: unknown } }>("Runtime.evaluate", {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return false;
              el.focus();
              return true;
            })()`,
            returnByValue: true,
          });
          if (!ok?.result?.value) throw new Error(`no element matched ${selector}`);
        }
        await browserSession.send("Input.insertText", { text });
        await settle(300);
        return { output: `typed ${text.length} character(s)${selector ? ` into ${selector}` : ""}` };
      }

      case "eval": {
        const expression = String(input?.expression ?? "").trim();
        if (!expression) throw new Error("eval needs an `expression`");
        const res = await browserSession.send<{ result: { value?: unknown; description?: string }; exceptionDetails?: any }>(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
        );
        if (res.exceptionDetails) {
          const d = res.exceptionDetails;
          return { output: `error: ${d?.exception?.description || d?.text || "evaluation failed"}` };
        }
        const value = res.result?.value ?? res.result?.description ?? null;
        return { output: typeof value === "string" ? value : JSON.stringify(value, null, 2).slice(0, 8000) };
      }

      default:
        return { output: `error: unknown action "${action}". Use open, screenshot, click, type, eval, console, or close.` };
    }
  } catch (error) {
    return { output: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
});
