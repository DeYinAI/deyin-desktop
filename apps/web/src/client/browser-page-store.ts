/** Browser-side per-thread HTML page store for chat-only web (no host WebSocket). */

const DB_NAME = "deyin-pages";
const DB_VERSION = 1;
const STORE = "pages";

const MAX_BYTES = 2 * 1024 * 1024;

function safeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid ${label}.`);
  }
  return trimmed;
}

function safeFileName(fileName: string): string {
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("Invalid page file name.");
  }
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  if (!base || base === "." || base === "..") throw new Error("Invalid page file name.");
  let safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe.toLowerCase().endsWith(".html")) safe += ".html";
  return safe;
}

function recordKey(threadId: string, file: string): string {
  return `${safeSegment(threadId, "thread id")}::${safeFileName(file)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("Failed to open page store."));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function saveBrowserPage(
  threadId: string,
  input: { html: string; fileName?: string },
): Promise<{ file: string }> {
  const html = input.html.trim();
  if (!html) throw new Error("Page HTML is empty.");
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Page exceeds ${MAX_BYTES} byte cap.`);
  const name = input.fileName ?? `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = safeFileName(name);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save page."));
      tx.oncomplete = () => resolve();
      tx.objectStore(STORE).put(html, recordKey(threadId, file));
    });
  } finally {
    db.close();
  }
  return { file };
}

export async function readBrowserPage(threadId: string, file: string): Promise<string> {
  const db = await openDb();
  try {
    const html = await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      tx.onerror = () => reject(tx.error ?? new Error("Failed to read page."));
      const req = tx.objectStore(STORE).get(recordKey(threadId, file));
      req.onerror = () => reject(req.error ?? new Error("Failed to read page."));
      req.onsuccess = () => resolve(req.result as string | undefined);
    });
    if (!html) throw new Error(`Page not found: ${file}`);
    return html;
  } finally {
    db.close();
  }
}
