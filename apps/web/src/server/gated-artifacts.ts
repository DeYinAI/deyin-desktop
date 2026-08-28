import { basename, extname } from "node:path";
import {
  ImageStore,
  PageStore,
  type StoredImage,
  buildArtifactObjectKey,
} from "@deyin/host-core";
import type { R2ObjectStore } from "./r2-client.js";

const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Session-scoped artifact storage: fast local cache in the sandbox plus optional
 * durable Cloudflare R2 objects keyed by OAuth `sub` so only that user can read them.
 */
export class GatedArtifactStore {
  readonly images: ImageStore;
  readonly pages: PageStore;

  constructor(
    private readonly userSub: string,
    sandboxRoot: string,
    private readonly r2?: R2ObjectStore,
  ) {
    this.images = new ImageStore(`${sandboxRoot}/.deyin/images`);
    this.pages = new PageStore(`${sandboxRoot}/.deyin/pages`);
  }

  /** Persist a locally saved image to R2 under the authenticated user's prefix. */
  async mirrorImageSave(threadId: string, fileName: string): Promise<void> {
    if (!this.r2) return;
    const stored = this.images.read(threadId, fileName);
    const key = buildArtifactObjectKey({
      userSub: this.userSub,
      kind: "images",
      threadId,
      fileName,
    });
    await this.r2.put({
      key,
      body: Buffer.from(stored.base64, "base64"),
      contentType: stored.mediaType,
    });
  }

  /** Read an image from the local cache, falling back to R2 for prior sessions. */
  async readImage(threadId: string, fileName: string): Promise<StoredImage> {
    try {
      return this.images.read(threadId, fileName);
    } catch (localErr) {
      if (!this.r2) throw localErr;
      const key = buildArtifactObjectKey({
        userSub: this.userSub,
        kind: "images",
        threadId,
        fileName,
      });
      const body = await this.r2.get(key);
      if (!body) throw localErr;
      const mediaType = IMAGE_MEDIA[extname(fileName).toLowerCase()] ?? "image/png";
      this.images.save(threadId, { base64: body.toString("base64"), mediaType, fileName });
      return this.images.read(threadId, fileName);
    }
  }

  /** Persist a locally written page to R2. */
  async mirrorPageWrite(threadId: string, fileName: string): Promise<void> {
    if (!this.r2) return;
    const html = this.pages.readPage(threadId, fileName);
    const key = buildArtifactObjectKey({
      userSub: this.userSub,
      kind: "pages",
      threadId,
      fileName: basename(fileName),
    });
    await this.r2.put({
      key,
      body: Buffer.from(html, "utf8"),
      contentType: "text/html; charset=utf-8",
    });
  }

  /** Read a page from the local cache, falling back to R2. */
  async readPage(threadId: string, fileName: string): Promise<string> {
    try {
      return this.pages.readPage(threadId, fileName);
    } catch (localErr) {
      if (!this.r2) throw localErr;
      const key = buildArtifactObjectKey({
        userSub: this.userSub,
        kind: "pages",
        threadId,
        fileName,
      });
      const body = await this.r2.get(key);
      if (!body) throw localErr;
      const html = body.toString("utf8");
      this.pages.writePage(threadId, fileName, html);
      return this.pages.readPage(threadId, fileName);
    }
  }

  /** Agent tool entry — writes locally then mirrors to R2. */
  async writePage(
    threadId: string,
    fileName: string,
    html: string,
  ): Promise<{ file: string; title: string; html: string }> {
    const written = this.pages.writePage(threadId, fileName, html);
    await this.mirrorPageWrite(threadId, written.title);
    return { file: written.file, title: written.title, html: this.pages.readPage(threadId, written.title) };
  }

  /** Save image locally and mirror to R2. */
  async saveImage(
    threadId: string,
    input: { base64: string; mediaType?: string; fileName?: string },
  ): Promise<{ file: string; mediaType: string }> {
    const saved = this.images.save(threadId, input);
    await this.mirrorImageSave(threadId, saved.file);
    return { file: saved.file, mediaType: saved.mediaType };
  }
}
