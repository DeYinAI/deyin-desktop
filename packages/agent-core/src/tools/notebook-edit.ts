import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { asOptionalString, asString, resolvePath } from "./util.js";

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  metadata?: Record<string, unknown>;
}

interface NotebookJson {
  cells?: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

function setCellSource(cell: NotebookCell, source: string): void {
  cell.source = source;
}

export const notebookEditTool: ToolDefinition = {
  name: "notebook_edit",
  description:
    "Edit a Jupyter notebook cell by index. Supports replace, insert, and delete actions.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Notebook .ipynb path." },
      cell_idx: { type: "number", description: "0-based cell index." },
      new_string: { type: "string", description: "New cell content (replace/insert)." },
      cell_language: {
        type: "string",
        enum: ["python", "markdown", "javascript", "typescript", "raw", "other"],
        description: "Cell language for insert.",
      },
      is_new_cell: { type: "boolean", description: "Insert a new cell instead of editing." },
    },
    required: ["path", "cell_idx"],
  },
  summarize: (args) => `notebook ${String(args.path ?? "")} cell ${String(args.cell_idx ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const rel = asString(args.path, "path");
    const abs = resolvePath(ctx.cwd, rel);
    const cellIdx = typeof args.cell_idx === "number" ? Math.max(0, Math.floor(args.cell_idx)) : 0;
    const isNew = args.is_new_cell === true;
    const newString = asOptionalString(args.new_string) ?? "";
    const lang = asOptionalString(args.cell_language) ?? "python";
    const cellType = lang === "markdown" ? "markdown" : "code";

    let notebook: NotebookJson;
    try {
      notebook = JSON.parse(await readFile(abs, "utf8")) as NotebookJson;
    } catch (err) {
      return `ERROR reading notebook: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!Array.isArray(notebook.cells)) notebook.cells = [];

    if (isNew) {
      const cell: NotebookCell = {
        cell_type: cellType,
        source: newString,
        metadata: cellType === "code" ? {} : {},
      };
      notebook.cells.splice(cellIdx, 0, cell);
    } else if (cellIdx >= notebook.cells.length) {
      return `ERROR: cell index ${cellIdx} out of range (${notebook.cells.length} cells).`;
    } else if (!newString && args.new_string === "") {
      notebook.cells.splice(cellIdx, 1);
    } else {
      const cell = notebook.cells[cellIdx]!;
      setCellSource(cell, newString);
      if (cellType === "markdown") cell.cell_type = "markdown";
    }

    await writeFile(abs, `${JSON.stringify(notebook, null, 1)}\n`, "utf8");
    return `Notebook ${rel} updated (${notebook.cells.length} cells).`;
  },
};
