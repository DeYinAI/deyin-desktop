import type {
  AuthorizationCodeRecord,
  DeviceCodeRecord,
  OAuthClient,
  OAuthStorage,
  RefreshTokenRecord,
  UserProfile,
} from "./types.js";

/**
 * In-memory storage for local development and tests. Not for production:
 * everything is lost on restart and it does not scale beyond one process.
 */
export class MemoryStorage implements OAuthStorage {
  private clients = new Map<string, OAuthClient>();
  private users = new Map<string, UserProfile>();
  private usersByEmail = new Map<string, string>();
  private codes = new Map<string, AuthorizationCodeRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();
  private deviceByDeviceCode = new Map<string, DeviceCodeRecord>();
  private deviceByUserCode = new Map<string, string>();

  addClient(client: OAuthClient): void {
    this.clients.set(client.clientId, client);
  }

  addUser(user: UserProfile): void {
    this.users.set(user.sub, user);
    this.usersByEmail.set(user.email.toLowerCase(), user.sub);
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.clients.get(clientId);
  }

  async getUser(sub: string): Promise<UserProfile | undefined> {
    return this.users.get(sub);
  }

  async findUserByEmail(email: string): Promise<UserProfile | undefined> {
    const sub = this.usersByEmail.get(email.toLowerCase());
    return sub ? this.users.get(sub) : undefined;
  }

  async saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    this.codes.set(record.code, record);
  }

  async takeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const record = this.codes.get(code);
    if (record) this.codes.delete(code);
    if (!record || record.expiresAt < Date.now()) return undefined;
    return record;
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(record.token, record);
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const record = this.refreshTokens.get(token);
    if (record) this.refreshTokens.delete(token);
    if (!record || record.expiresAt < Date.now()) return undefined;
    return record;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    this.refreshTokens.delete(token);
  }

  async saveDeviceCode(record: DeviceCodeRecord): Promise<void> {
    this.deviceByDeviceCode.set(record.deviceCode, record);
    this.deviceByUserCode.set(record.userCode, record.deviceCode);
  }

  async getDeviceCodeByDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | undefined> {
    return this.deviceByDeviceCode.get(deviceCode);
  }

  async getDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRecord | undefined> {
    const deviceCode = this.deviceByUserCode.get(userCode);
    return deviceCode ? this.deviceByDeviceCode.get(deviceCode) : undefined;
  }

  async updateDeviceCode(record: DeviceCodeRecord): Promise<void> {
    this.deviceByDeviceCode.set(record.deviceCode, record);
  }
}

/**
 * Seed a MemoryStorage with the first-party Deyin desktop client and a demo user,
 * so `pnpm oauth:dev` is usable immediately.
 */
export function seedDevStorage(): MemoryStorage {
  const storage = new MemoryStorage();

  storage.addClient({
    clientId: "deyin-desktop",
    name: "Deyin Desktop",
    isPublic: true,
    redirectUris: [
      "deyin://oauth/callback",
      "http://127.0.0.1:*/callback",
      "http://localhost:*/callback",
      "http://localhost:5273/auth/callback",
    ],
    allowedScopes: ["openid", "profile", "email", "offline_access", "model:invoke"],
    grantTypes: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
  });

  storage.addUser({
    sub: "user_demo_001",
    email: "demo@deyin.dev",
    emailVerified: true,
    name: "Demo Deyin User",
    picture: "https://api.openference.com/avatars/demo.png",
    plan: "free",
  });

  return storage;
}
