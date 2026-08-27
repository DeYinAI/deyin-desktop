/** Browser-side per-thread image store for chat-only web (no host WebSocket). */

const DB_NAME = "deyin-images";
const DB_VERSION = 1;
const STORE = "images";

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export interface StoredBrowserImage {
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
    throw new Error("Invalid image file name.");
  }
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  if (!base || base === "." || base === "..") throw new Error("Invalid image file name.");
  let safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = safe.slice(safe.lastIndexOf(".")).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    safe += EXTENSIONS[mediaType] ?? ".png";
  }
  return safe;
}

function recordKey(threadId: string, file: string): string {
  return `${safeSegment(threadId, "thread id")}::${safeFileName(file, "image/png")}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("Failed to open image store."));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function saveBrowserImage(
  threadId: string,
  input: { base64: string; mediaType?: string; fileName?: string },
): Promise<{ file: string; mediaType: string }> {
  const mediaType = input.mediaType && EXTENSIONS[input.mediaType] ? input.mediaType : "image/png";
  if (!input.base64) throw new Error("Image data is empty.");
  const name = input.fileName ?? `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = safeFileName(name, mediaType);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save image."));
      tx.oncomplete = () => resolve();
      tx.objectStore(STORE).put({ base64: input.base64, mediaType }, recordKey(threadId, file));
    });
  } finally {
    db.close();
  }
  return { file, mediaType };
}

export async function readBrowserImage(threadId: string, file: string): Promise<StoredBrowserImage> {
  const db = await openDb();
  try {
    const stored = await new Promise<StoredBrowserImage | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      tx.onerror = () => reject(tx.error ?? new Error("Failed to read image."));
      const req = tx.objectStore(STORE).get(recordKey(threadId, file));
      req.onerror = () => reject(req.error ?? new Error("Failed to read image."));
      req.onsuccess = () => resolve(req.result as StoredBrowserImage | undefined);
    });
    if (!stored?.base64) throw new Error(`Image not found: ${file}`);
    return stored;
  } finally {
    db.close();
  }
}

export function browserImageDataUrl(image: StoredBrowserImage): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}
