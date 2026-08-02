import { join } from "node:path";
import { app } from "electron";
import { VisualizeStore } from "./visualize-store.js";

/** Electron-backed visualization store under userData. */
export class VisualizeService extends VisualizeStore {
  constructor(root?: string) {
    super(root ?? join(app.getPath("userData"), "visualizations"));
  }
}

export { parseInlineVisDirectives, stripInlineVisDirectives } from "./visualize-directive.js";
