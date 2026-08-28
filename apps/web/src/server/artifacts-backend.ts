import { R2Client, loadR2ConfigFromEnv, type R2ObjectStore } from "./r2-client.js";

let sharedR2: R2ObjectStore | null | undefined;

/** Process-wide R2 client when host-server env vars are set; otherwise undefined. */
export function getSharedArtifactObjectStore(): R2ObjectStore | undefined {
  if (sharedR2 === undefined) {
    const config = loadR2ConfigFromEnv();
    sharedR2 = config ? new R2Client(config) : null;
  }
  return sharedR2 ?? undefined;
}

/** Test hook — inject a mock object store or reset lazy init. */
export function setSharedArtifactObjectStoreForTests(store: R2ObjectStore | null | undefined): void {
  sharedR2 = store;
}
