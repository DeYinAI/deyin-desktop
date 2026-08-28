import { join } from "node:path";
import { app } from "electron";
import { PageStore } from "@deyin/host-core";

/** Electron-backed page artifact store under userData. */
export class PageService extends PageStore {
  constructor(root?: string) {
    super(root ?? join(app.getPath("userData"), "pages"));
  }
}
