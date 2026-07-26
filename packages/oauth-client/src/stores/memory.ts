import type { TokenSet, TokenStore } from "../types.js";

/** Non-persistent token store. Useful for tests and short-lived processes. */
export class MemoryTokenStore implements TokenStore {
  private tokens: TokenSet | undefined;

  async load(): Promise<TokenSet | undefined> {
    return this.tokens;
  }

  async save(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = undefined;
  }
}
