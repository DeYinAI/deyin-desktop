import { join } from "node:path";
import { app } from "electron";
import { ImageStore } from "@deyin/host-core";

/** Electron-backed generated-image store under userData. */
export class ImageService extends ImageStore {
  constructor(root?: string) {
    super(root ?? join(app.getPath("userData"), "images"));
  }
}
