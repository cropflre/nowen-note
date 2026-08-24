import crypto from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { ArtifactStore } from "./artifactStore.js";
import { artifactKeyForDigest, assertArtifactKey, assertSha256, assertStagedKey, createStagedKey } from "./artifactStore.js";

export interface S3ArtifactStoreOptions {
  region: string;
  bucket: string;
  prefix: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface ObjectDigest {
  sha256: string;
  sizeBytes: number;
}

function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === "NotFound" || value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404;
}

function isConditionalConflict(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 409 || status === 412;
}

function encodeCopySource(bucket: string, key: string): string {
  return `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3ArtifactStoreOptions) {
    const clientConfig: S3ClientConfig = {
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      },
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    };
    this.client = new S3Client(clientConfig);
    this.bucket = options.bucket;
    this.prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  }

  async stage(operationId: string, bytes: Buffer): Promise<string> {
    if (bytes.byteLength === 0) throw new Error("artifact cannot be empty");
    const stagedKey = createStagedKey(operationId, crypto.randomUUID());
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(stagedKey),
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: "application/zip",
      Metadata: { sha256, size: String(bytes.byteLength), state: "staged" },
      IfNoneMatch: "*",
    }));
    return stagedKey;
  }

  async commit(stagedKey: string, sha256: string): Promise<string> {
    assertStagedKey(stagedKey);
    assertSha256(sha256);
    const stagedObjectKey = this.objectKey(stagedKey);
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: stagedObjectKey }));
    const staged = await this.digestObject(stagedObjectKey);
    if (head.Metadata?.sha256 !== sha256 || head.Metadata?.size !== String(staged.sizeBytes)
      || head.ContentLength !== staged.sizeBytes || staged.sha256 !== sha256) {
      throw new Error("staged S3 artifact digest or metadata mismatch");
    }

    const finalKey = artifactKeyForDigest(sha256);
    const finalObjectKey = this.objectKey(finalKey);
    try {
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        Key: finalObjectKey,
        CopySource: encodeCopySource(this.bucket, stagedObjectKey),
        CopySourceIfMatch: head.ETag,
        IfNoneMatch: "*",
        ContentType: "application/zip",
        CacheControl: "public,max-age=31536000,immutable",
        MetadataDirective: "REPLACE",
        Metadata: { sha256, size: String(staged.sizeBytes), state: "committed" },
      }));
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      const existing = await this.digestObject(finalObjectKey);
      const existingHead = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: finalObjectKey }));
      if (existing.sha256 !== sha256 || existing.sizeBytes !== staged.sizeBytes
        || existingHead.Metadata?.sha256 !== sha256 || existingHead.Metadata?.size !== String(staged.sizeBytes)) {
        throw new Error("immutable S3 artifact key already contains different content");
      }
    }
    await this.removeStaged(stagedKey);
    return finalKey;
  }

  async read(key: string): Promise<ReadableStream<Uint8Array> | NodeJS.ReadableStream> {
    assertArtifactKey(key);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    if (!response.Body) throw new Error("artifact object body is unavailable");
    if (typeof response.Body.transformToWebStream === "function") return response.Body.transformToWebStream();
    return response.Body as NodeJS.ReadableStream;
  }

  async exists(key: string): Promise<boolean> {
    assertArtifactKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async removeStaged(stagedKey: string): Promise<void> {
    assertStagedKey(stagedKey);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(stagedKey) }));
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: "S3 artifact store ready" };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  private objectKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private async digestObject(key: string): Promise<ObjectDigest> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error("S3 artifact object body is unavailable");
    const hash = crypto.createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    return { sha256: hash.digest("hex"), sizeBytes };
  }
}
