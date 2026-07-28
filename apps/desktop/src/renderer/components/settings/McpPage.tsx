import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { McpServerEntry, McpTestResult, McpTransport } from "../../../shared/types.js";

/**
 * MCP servers: live list from mcp.json files (workspace + user + plugins) plus
 * the built-in in-process servers. Custom servers are written to ~/.deyin/mcp.json.
 */
export function McpPage({ onToggle }: { onToggle: (id: string, enabled: boolean) => void }) {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<Record<string, McpTestResult | "running">>({});

  const reload = useCallback(() => {
    void window.deyin.mcp.list().then(setServers).catch(() => setServers([]));
  }, []);

  useEffect(() => reload(), [reload]);

  const test = async (name: string) => {
    setTests((cur) => ({ ...cur, [name]: "running" }));
    const result = await window.deyin.mcp.test(name);
    setTests((cur) => ({ ...cur, [name]: result }));
  };

  const remove = async (name: string) => {
    setServers(await window.deyin.mcp.remove(name));
  };

  const toggle = (server: McpServerEntry, enabled: boolean) => {
    onToggle(server.id, enabled);
    setServers((cur) => cur.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
  };

  return (
    <div className="settings-page">
      <PageHeader
        title="MCP Servers"
        description="Model Context Protocol servers exposing external tools to agent sessions. Configured in .deyin/mcp.json (workspace) and ~/.deyin/mcp.json (user)."
      >
        <button className="icon-btn" title="Reload" onClick={reload}>
          <Icon name="refresh" size={14} />
        </button>
      </PageHeader>

      {servers.map((server) => {
        const result = tests[server.name];
        return (
          <SettingCard
            key={server.id}
            title={`${server.name}${server.transport !== "stdio" ? ` · ${server.transport.toUpperCase()}` : ""}`}
            description={
              (server.transport === "stdio"
                ? server.command
                  ? `${server.command} ${(server.args ?? []).join(" ")}`
                  : "Built-in (runs inside Deyin)."
                : server.url ?? "") + ` — ${server.source}`
            }
          >
            <div className="field__row">
              {result && result !== "running" && (
                <span className={result.ok ? "hint hint--ok" : "hint hint--bad"}>
                  {result.ok ? `${result.toolCount ?? 0} tools` : result.message ?? "failed"}
                </span>
              )}
              <button
                className="chip chip--small"
                disabled={result === "running"}
                onClick={() => void test(server.name)}
              >
                {result === "running" ? "Testing…" : "Test"}
              </button>
              {server.source === "user" && (
                <button className="icon-btn icon-btn--small" title="Remove" onClick={() => void remove(server.name)}>
                  <Icon name="trash" size={12} />
                </button>
              )}
              <Toggle checked={server.enabled} onChange={(v) => toggle(server, v)} />
            </div>
          </SettingCard>
        );
      })}
      {servers.length === 0 && <div className="hint">No MCP servers configured.</div>}

      <SectionTitle>Custom server</SectionTitle>
      {adding ? (
        <AddServerForm
          onDone={(next) => {
            setAdding(false);
            if (next) setServers(next);
          }}
        />
      ) : (
        <button className="providers__add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          Add custom MCP server
        </button>
      )}
    </div>
  );
}

function AddServerForm({ onDone }: { onDone: (servers: McpServerEntry[] | null) => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const [cmd, ...args] = command.trim().split(/\s+/);
      const next = await window.deyin.mcp.add({
        name: name.trim(),
        transport,
        command: transport === "stdio" ? cmd : undefined,
        args: transport === "stdio" && args.length > 0 ? args : undefined,
        url: transport !== "stdio" ? url.trim() : undefined,
      });
      onDone(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mcp-add">
      <div className="field">
        <label className="field__label">Name</label>
        <input className="input" placeholder="my-server" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label">Transport</label>
        <select className="select" style={{ width: "100%" }} value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">stdio (local command)</option>
          <option value="sse">SSE (remote URL)</option>
          <option value="http">Streamable HTTP (remote URL)</option>
        </select>
      </div>
      {transport === "stdio" ? (
        <div className="field">
          <label className="field__label">Command</label>
          <input
            className="input"
            placeholder="npx -y @modelcontextprotocol/server-filesystem ${workspaceFolder}"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <div className="hint">Supports ${"{env:NAME}"}, ${"{workspaceFolder}"} and ${"{userHome}"} placeholders.</div>
        </div>
      ) : (
        <div className="field">
          <label className="field__label">URL</label>
          <input className="input" placeholder="https://mcp.example.com/sse" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      {error && <div className="hint hint--bad">{error}</div>}
      <div className="providers__add-actions">
        <button className="chip chip--small" onClick={() => onDone(null)}>Cancel</button>
        <button className="chip chip--small chip--active" onClick={() => void submit()}>Add server</button>
      </div>
    </div>
  );
}
