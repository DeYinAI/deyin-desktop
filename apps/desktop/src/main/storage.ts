import { app, safeStorage } from "electron";
import { FileStorage, PLAIN_CIPHER_PREFIX, plainCipher, type SecretCipher } from "@deyin/host-core";

/**
 * Adapts Electron's OS-keychain-backed safeStorage to host-core's SecretCipher.
 * Preserves the historical on-disk format: base64 of the encrypted buffer, or a
 * "plain:"-prefixed plaintext fallback when OS encryption is unavailable.
 */
export class ElectronSafeStorageCipher implements SecretCipher {
  encrypt(plaintext: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(plaintext).toString("base64");
      }
    } catch {
      // fall through to plaintext marker
    }
    return plainCipher.encrypt(plaintext);
  }

  decrypt(stored: string): string | null {
    if (stored.startsWith(PLAIN_CIPHER_PREFIX)) return stored.slice(PLAIN_CIPHER_PREFIX.length);
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }
}

/** The desktop's Storage: JSON files in userData, secrets through safeStorage. */
export function createDesktopStorage(): FileStorage {
  return new FileStorage(app.getPath("userData"), new ElectronSafeStorageCipher());
}
