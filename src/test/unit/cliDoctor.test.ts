/*
 * Copyright (c) 2026 Yargı Engine
 *
 * This file is part of YargiX — AI coding agent for your editor.
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * CLI health check.
 *
 * Doctor is what a CI job or a first-run user hits when the agent "does
 * nothing": the report must name the missing model or dead endpoint, and it
 * must never echo an API key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateDoctor, formatDoctor, runDoctor, type DoctorFacts, type DoctorFetch } from "../../cli/doctor";
import { serializeSession, snapshotSession } from "../../cli/session";

function facts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    version: "0.1.4",
    node: "v20.11.0",
    nodeMajor: 20,
    cwd: "/repo",
    cwdOk: true,
    model: "local",
    baseUrl: "http://127.0.0.1:8080/v1",
    hasApiKey: false,
    ...overrides,
  };
}

function byId(report: ReturnType<typeof evaluateDoctor>, id: string) {
  const check = report.checks.find((c) => c.id === id);
  assert.ok(check, `missing check ${id}`);
  return check;
}

test("a healthy local setup is ok with a key warning", () => {
  const report = evaluateDoctor(
    facts({
      endpoint: { ok: true, status: 200, models: ["local", "other"] },
      ollama: { ok: true, models: ["llama3.1"] },
      session: { present: true, valid: true, steps: 3 },
    }),
  );
  assert.equal(report.ok, true);
  assert.equal(report.failures, 0);
  assert.equal(byId(report, "runtime").status, "ok");
  assert.equal(byId(report, "model").status, "ok");
  assert.equal(byId(report, "reachability").status, "ok");
  assert.equal(byId(report, "model-available").status, "ok");
  assert.equal(byId(report, "api-key").status, "warn");
  assert.equal(byId(report, "ollama").status, "ok");
  assert.equal(byId(report, "session").status, "ok");
});

test("missing model, endpoint, and cwd are failures", () => {
  const report = evaluateDoctor(
    facts({
      model: "",
      baseUrl: "",
      cwdOk: false,
      cwd: "/missing",
    }),
  );
  assert.equal(report.ok, false);
  assert.equal(byId(report, "model").status, "fail");
  assert.equal(byId(report, "endpoint").status, "fail");
  assert.equal(byId(report, "cwd").status, "fail");
  assert.equal(byId(report, "reachability").status, "skip");
});

test("a dead endpoint fails reachability and an unknown model is a warning", () => {
  const dead = evaluateDoctor(facts({ endpoint: { ok: false, status: 503, error: "HTTP 503" } }));
  assert.equal(dead.ok, false);
  assert.equal(byId(dead, "reachability").status, "fail");

  const unknown = evaluateDoctor(
    facts({ endpoint: { ok: true, status: 200, models: ["other"] }, model: "local" }),
  );
  assert.equal(unknown.ok, true);
  assert.equal(byId(unknown, "model-available").status, "warn");
});

test("ollama down and a missing session are not failures", () => {
  const report = evaluateDoctor(
    facts({
      endpoint: { ok: true, status: 200, models: ["local"] },
      ollama: { ok: false, error: "not reachable" },
      session: { present: false },
    }),
  );
  assert.equal(report.ok, true);
  assert.equal(byId(report, "ollama").status, "warn");
  assert.equal(byId(report, "session").status, "skip");
});

test("an invalid session file is a failure so --resume cannot surprise later", () => {
  const report = evaluateDoctor(facts({ session: { present: true, valid: false, error: "not valid JSON" } }));
  assert.equal(report.ok, false);
  assert.match(byId(report, "session").detail, /not valid JSON/);
});

test("old Node is a failure", () => {
  const report = evaluateDoctor(facts({ node: "v18.20.0", nodeMajor: 18 }));
  assert.equal(byId(report, "runtime").status, "fail");
  assert.equal(report.ok, false);
});

test("the printed report never contains an API key", () => {
  const secret = "sk-secret-do-not-print";
  const report = evaluateDoctor(
    facts({ hasApiKey: true, endpoint: { ok: true, status: 200, models: ["local"] } }),
  );
  const text = formatDoctor(report);
  assert.equal(text.includes(secret), false);
  assert.match(text, /api-key/);
  assert.match(byId(report, "api-key").detail, /^set$/);
  assert.match(text, /0 failure/);
});

test("runDoctor probes the endpoint and Ollama through the injected fetch", async () => {
  const calls: string[] = [];
  const fetchFn: DoctorFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "local" }] }),
        text: async () => "",
      };
    }
    if (url.includes("11434")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: "llama3.1:8b" }] }),
        text: async () => "",
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  const snap = serializeSession(
    snapshotSession({ mode: "ask", model: "local", cwd: "/repo", steps: [{ kind: "user", text: "hi" }], now: 1 }),
  );
  const report = await runDoctor(
    {
      version: "0.1.4",
      node: "v22.0.0",
      cwd: "/repo",
      model: "local",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "sk-secret-do-not-print",
    },
    {
      fetch: fetchFn,
      stat: async () => ({ isDirectory: () => true }),
      readFile: async () => snap,
    },
  );
  assert.equal(report.ok, true);
  assert.ok(calls.some((u) => u.endsWith("/models")));
  assert.ok(calls.some((u) => u.includes("11434")));
  assert.equal(byId(report, "model-available").status, "ok");
  assert.equal(byId(report, "ollama").status, "ok");
  assert.equal(byId(report, "session").status, "ok");
  assert.equal(JSON.stringify(report).includes("sk-secret-do-not-print"), false);
});

test("a refused endpoint is a failure and a missing session file is skipped", async () => {
  const report = await runDoctor(
    {
      version: "0.1.4",
      node: "v20.0.0",
      cwd: "/repo",
      model: "local",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "",
    },
    {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      stat: async () => ({ isDirectory: () => true }),
      readFile: async () => {
        throw new Error("ENOENT");
      },
    },
  );
  assert.equal(report.ok, false);
  assert.equal(byId(report, "reachability").status, "fail");
  assert.equal(byId(report, "ollama").status, "warn");
  assert.equal(byId(report, "session").status, "skip");
});
