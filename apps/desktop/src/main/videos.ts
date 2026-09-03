import { join } from "node:path";
import { app } from "electron";
import { VideoStore } from "@deyin/host-core";

/** Electron-backed generated-video store under userData. */
export class VideoService extends VideoStore {
  constructor(root?: string) {
    super(root ?? join(app.getPath("userData"), "videos"));
  }
}
