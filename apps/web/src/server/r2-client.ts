import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactKind } from "@deyin/host-core";
import { buildArtifactObjectKey } from "@deyin/host-core";

export interface R2Config {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2ObjectStore {
  put(params: { key: string; body: Buffer; contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  listPrefix(prefix: string): Promise<string[]>;
}

/** Load R2 credentials from host-server environment variables. */
export function loadR2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const bucket = env.DEYIN_R2_BUCKET?.trim();
  const accountId = env.DEYIN_R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.DEYIN_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.DEYIN_R2_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accountId || !accessKeyId || !secretAccessKey) return null;
  return { bucket, accountId, accessKeyId, secretAccessKey };
}

/** S3-compatible client for Cloudflare R2. */
export class R2Client implements R2ObjectStore {
  private client: S3Client;
  private bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(params: { key: string; body: Buffer; contentType?: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw err;
    }
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
      }),
    );
    return (out.Contents ?? [])
      .map((item: { Key?: string }) => item.Key)
      .filter((key): key is string => typeof key === "string");
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** In-memory object store for tests. */
export class MemoryObjectStore implements R2ObjectStore {
  private objects = new Map<string, Buffer>();

  async put(params: { key: string; body: Buffer }): Promise<void> {
    this.objects.set(params.key, Buffer.from(params.body));
  }

  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return [...this.objects.keys()].filter((key) => key.startsWith(normalized)).sort();
  }
}

export function artifactKey(userSub: string, kind: ArtifactKind, threadId: string, fileName: string): string {
  return buildArtifactObjectKey({ userSub, kind, threadId, fileName });
}
