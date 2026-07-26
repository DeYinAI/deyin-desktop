import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type JWK,
  type KeyLike,
} from "jose";
import type { ProviderConfig } from "./config.js";

const ALG = "RS256";

export interface Keystore {
  kid: string;
  privateKey: KeyLike;
  publicKey: KeyLike;
}

/**
 * Build a keystore. In production pass PEM strings loaded from a secret manager.
 * In dev, omit them and an ephemeral keypair is generated (tokens won't survive
 * a restart, which is fine for local work).
 */
export async function createKeystore(opts?: {
  privateKeyPem?: string;
  publicKeyPem?: string;
  kid?: string;
}): Promise<Keystore> {
  if (opts?.privateKeyPem && opts?.publicKeyPem) {
    const privateKey = await importPKCS8(opts.privateKeyPem, ALG);
    const publicKey = await importSPKI(opts.publicKeyPem, ALG);
    return { kid: opts.kid ?? "deyin-key-1", privateKey, publicKey };
  }
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  return { kid: opts?.kid ?? "deyin-dev-key", privateKey, publicKey };
}

export async function publicJwks(keystore: Keystore): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(keystore.publicKey);
  jwk.kid = keystore.kid;
  jwk.alg = ALG;
  jwk.use = "sig";
  return { keys: [jwk] };
}

export interface AccessTokenClaims {
  sub: string;
  clientId: string;
  scope: string;
  plan?: string;
}

/**
 * Access token as a JWT (`typ: at+jwt`, RFC 9068). Openference's model gateway can
 * verify it against the JWKS instead of a DB lookup on the hot path.
 */
export async function signAccessToken(
  keystore: Keystore,
  config: ProviderConfig,
  claims: AccessTokenClaims,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: claims.scope, client_id: claims.clientId, plan: claims.plan })
    .setProtectedHeader({ alg: ALG, kid: keystore.kid, typ: "at+jwt" })
    .setIssuer(config.issuer)
    .setSubject(claims.sub)
    .setAudience(config.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtl)
    .sign(keystore.privateKey);
}

export interface IdTokenInput {
  sub: string;
  clientId: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
}

/** OIDC ID token, issued when the `openid` scope is granted. */
export async function signIdToken(
  keystore: Keystore,
  config: ProviderConfig,
  input: IdTokenInput,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    email: input.email,
    email_verified: input.emailVerified,
    name: input.name,
    picture: input.picture,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid: keystore.kid })
    .setIssuer(config.issuer)
    .setSubject(input.sub)
    .setAudience(input.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtl);
  return jwt.sign(keystore.privateKey);
}
