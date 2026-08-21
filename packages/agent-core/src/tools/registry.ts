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

  toWire(): WireTool[] {
    return this.list().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
}
