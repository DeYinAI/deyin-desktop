/** Browser-side per-thread video store for chat-only web (no host WebSocket). */

const DB_NAME = "deyin-videos";
const DB_VERSION = 1;
const STORE = "videos";

const EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

export interface StoredBrowserVideo {
  base64: string;
  mediaType: string;
}

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

function safeFileName(fileName: string, mediaType: string): string {
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("Invalid video file name.");
  }
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  if (!base || base === "." || base === "..") throw new Error("Invalid video file name.");
  let safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = safe.slice(safe.lastIndexOf(".")).toLowerCase();
  if (![".mp4", ".webm"].includes(ext)) {
    safe += EXTENSIONS[mediaType] ?? ".mp4";
  }
  return safe;
}

function recordKey(threadId: string, file: string): string {
  return `${safeSegment(threadId, "thread id")}::${safeFileName(file, "video/mp4")}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("Failed to open video store."));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function saveBrowserVideo(
  threadId: string,
  input: { base64: string; mediaType?: string; fileName?: string },
): Promise<{ file: string; mediaType: string }> {
  const mediaType = input.mediaType && EXTENSIONS[input.mediaType] ? input.mediaType : "video/mp4";
  if (!input.base64) throw new Error("Video data is empty.");
  const name = input.fileName ?? `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = safeFileName(name, mediaType);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save video."));
      tx.oncomplete = () => resolve();
      tx.objectStore(STORE).put({ base64: input.base64, mediaType }, recordKey(threadId, file));
    });
  } finally {
    db.close();
  }
  return { file, mediaType };
}

export async function readBrowserVideo(threadId: string, file: string): Promise<StoredBrowserVideo> {
  const db = await openDb();
  try {
    const stored = await new Promise<StoredBrowserVideo | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      tx.onerror = () => reject(tx.error ?? new Error("Failed to read video."));
      const req = tx.objectStore(STORE).get(recordKey(threadId, file));
      req.onerror = () => reject(req.error ?? new Error("Failed to read video."));
      req.onsuccess = () => resolve(req.result as StoredBrowserVideo | undefined);
    });
    if (!stored?.base64) throw new Error(`Video not found: ${file}`);
    return stored;
  } finally {
    db.close();
  }
}

export function browserVideoDataUrl(video: StoredBrowserVideo): string {
  return `data:${video.mediaType};base64,${video.base64}`;
}
