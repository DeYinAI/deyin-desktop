import { join } from "node:path";
import { app } from "electron";
import { SecurityFindingsStore } from "./security-findings-store.js";

/** Electron-backed security findings store under userData. */
export class SecurityService extends SecurityFindingsStore {
  constructor(root?: string) {
    super(root ?? join(app.getPath("userData"), "security-findings"));
  }
}
