import type { ToolDefinition, WireTool } from "../types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Drop a tool the host cannot serve (e.g. no image model on the plan). */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** New registry containing only the named tools; unknown names are skipped. */
  filtered(names: Iterable<string>): ToolRegistry {
    const allowed = new Set(names);
    const out = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) out.register(tool);
    }
    return out;
  }

  /**
   * The tool array as it goes on the wire.
   *
   * Sorted by name, deliberately. The tool schemas sit in the provider's cached
   * prefix, so their byte order is part of the cache key — but insertion order
   * depends on plugin load order and on when each MCP server finished
   * connecting, which varies run to run. Worse, the cache diagnostics hash a
   * *sorted* copy, so an insertion-order change would silently invalidate the
   * real cache while the diagnostic reported "nothing changed". Sorting here
   * makes the bytes we send and the bytes we hash the same thing.
   */
  toWire(): WireTool[] {
    return this.list()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
  }
}
