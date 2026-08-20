/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { FeatureConfig, McpServerConfig, McpStatus } from "../features";
import { Toggle } from "./Toggle";
import { MCP_CATALOG, isAlreadyAdded } from "../../../src/shared/mcpCatalog";
import { vscode } from "../../shared/vscode";

export function McpPanel({
  features,
  setFeatures,
  status,
  onSync,
}: {
  features: FeatureConfig;
  setFeatures: (f: Partial<FeatureConfig>) => void;
  status: McpStatus[];
  onSync: () => void;
}) {
  // null = closed; { index: -1 } = adding a new server; otherwise editing that index.
  const [editing, setEditing] = React.useState<{ index: number; draft: McpServerConfig } | null>(null);
  const [browsing, setBrowsing] = React.useState(false);

  const remove = (i: number) => {
    setFeatures({ mcpServers: features.mcpServers.filter((_, idx) => idx !== i) });
    setTimeout(onSync, 0);
  };
  const toggle = (i: number, enabled: boolean) => {
    setFeatures({ mcpServers: features.mcpServers.map((s, idx) => (idx === i ? { ...s, enabled } : s)) });
    setTimeout(onSync, 0);
  };

  const openAdd = () => setEditing({ index: -1, draft: { name: "", transport: "stdio", command: "", args: [], enabled: true } });
  const openEdit = (i: number) => setEditing({ index: i, draft: { ...features.mcpServers[i] } });

  const save = (cfg: McpServerConfig) => {
    const next = editing && editing.index >= 0
      ? features.mcpServers.map((s, idx) => (idx === editing.index ? cfg : s))
      : [...features.mcpServers, cfg];
    setFeatures({ mcpServers: next });
    setEditing(null);
    setTimeout(onSync, 0);
  };

  const statusFor = (name: string) => status.find((s) => s.name === name);

  return (
    <>
      <h1 className="page-title">Tools &amp; MCPs</h1>

      <div className="section-label">MCP Servers</div>
      <p className="panel-hint">Connected Model Context Protocol servers and the tools they expose.</p>
      {features.mcpServers.length === 0 && (
        <div className="empty-card">No MCP servers yet. Add one to get started.</div>
      )}
      {features.mcpServers.map((srv, i) => {
        const st = statusFor(srv.name);
        const tools = st?.tools ?? [];
        return (
          <div className="feature-card" key={i}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="link" size={14} />
                <span>{srv.name || "(unnamed)"}</span>
                <span className={"mcp-status " + (st?.connected ? "ok" : st?.error ? "err" : "idle")}>
                  {st?.connected ? `${st.toolCount} tools` : st?.error ? "error" : "idle"}
                </span>
              </div>
              <Toggle checked={srv.enabled} onChange={(v) => toggle(i, v)} />
              <button className="btn-ghost sm" onClick={() => openEdit(i)}>
                <Icon name="settings" size={13} /> Edit
              </button>
              <button className="icon-btn" onClick={() => remove(i)} title="Remove">
                <Icon name="trash" size={14} />
              </button>
            </div>
            <div className="fc-body">
              {st?.error ? (
                <div className="fc-error">{st.error}</div>
              ) : tools.length === 0 ? (
                <div className="row-desc">{st?.connected ? "No tools exposed." : "Not connected — enable and Reconnect."}</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {tools.map((t) => (
                    <span className="badge-tag glob" key={t}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="panel-actions">
        <button className="btn-ghost" onClick={openAdd}>
          <Icon name="plus" size={14} /> Add MCP Server
        </button>
        <button className="btn-ghost" onClick={() => setBrowsing((b) => !b)}>
          <Icon name="search" size={14} /> {browsing ? "Hide catalog" : "Browse catalog"}
        </button>
        <button className="btn-ghost" onClick={onSync}>
          Reconnect
        </button>
      </div>

      {browsing && (
        <>
          <div className="section-label">Catalog</div>
          <p className="panel-hint">
            Hand-checked servers you can add in one click. Adding one runs its command on this machine, so only add
            what you actually want. Anything not listed can still be added by hand.
          </p>
          {MCP_CATALOG.map((entry) => {
            const added = isAlreadyAdded(entry, features.mcpServers);
            return (
              <div className="feature-card" key={entry.id}>
                <div className="fc-head">
                  <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name="link" size={14} />
                    <span>{entry.name}</span>
                    <span className="badge-tag glob">{entry.category}</span>
                  </div>
                  <button
                    className="btn-ghost sm"
                    disabled={added}
                    onClick={() => vscode.postMessage({ type: "addMcpFromCatalog", entryId: entry.id })}
                  >
                    <Icon name="plus" size={13} /> {added ? "Added" : "Add"}
                  </button>
                  <button
                    className="icon-btn"
                    title="Documentation"
                    onClick={() => vscode.postMessage({ type: "openExternal", url: entry.docs })}
                  >
                    <Icon name="link" size={14} />
                  </button>
                </div>
                <div className="fc-body">
                  <div className="row-desc">{entry.description}</div>
                  {entry.requires && <div className="row-desc" style={{ opacity: 0.8 }}>Requires: {entry.requires}</div>}
                </div>
              </div>
            );
          })}
        </>
      )}

      {editing && (
        <McpModal
          server={editing.draft}
          isNew={editing.index < 0}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </>
  );
}

function McpModal({ server, isNew, onClose, onSave }: { server: McpServerConfig; isNew: boolean; onClose: () => void; onSave: (s: McpServerConfig) => void }) {
  const [draft, setDraft] = React.useState<McpServerConfig>(server);
  const set = (patch: Partial<McpServerConfig>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{isNew ? "Add MCP Server" : "Edit MCP Server"}</h2>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="fc-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="my-server" />
          </label>
          <label className="fc-field">
            <span>Command</span>
            <input value={draft.command ?? ""} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
          </label>
          <label className="fc-field">
            <span>Args (space-separated)</span>
            <input
              value={(draft.args ?? []).join(" ")}
              onChange={(e) => set({ args: e.target.value.split(/\s+/).filter(Boolean) })}
              placeholder="-y @modelcontextprotocol/server-filesystem ."
            />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!draft.name.trim() || !draft.command?.trim()} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>Save</button>
        </div>
      </div>
    </div>
  );
}
