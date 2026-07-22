/**
 * 第三方图床服务
 *
 * 支持 S3 兼容对象存储（AWS S3、Cloudflare R2、MinIO 等）作为图床。
 * 图片上传后返回公开 URL，直接嵌入笔记内容。
 */

import crypto from "crypto";
import { systemSettingsRepository } from "../repositories/systemSettingsRepository";

const SETTING_KEY = "imageHosting:config";
const DEFAULT_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface ImageHostingConfig {
  enabled: boolean;
  provider: "s3-compatible" | "custom";
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  pathPrefix: string;
  usePathStyle: boolean;
  maxFileSizeMb: number;
  allowedTypes: string[];
}

export interface ImageHostingConfigPublic {
  enabled: boolean;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  publicBaseUrl: string;
  pathPrefix: string;
  usePathStyle: boolean;
  maxFileSizeMb: number;
  allowedTypes: string[];
  updatedAt: string | null;
}

export interface WriteImageHostingConfigInput {
  enabled: boolean;
  provider?: "s3-compatible" | "custom";
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string;
  publicBaseUrl: string;
  pathPrefix?: string;
  usePathStyle?: boolean;
  maxFileSizeMb?: number;
  allowedTypes?: string[];
}

export interface ImageUploadResult {
  success: boolean;
  url?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
  error?: string;
  code?: string;
}

function getEncryptionKeySource(): { key: string; source: string } {
  const dedicatedKey = process.env.IMAGE_HOSTING_ENCRYPTION_KEY;
  if (dedicatedKey) {
    return { key: dedicatedKey, source: "IMAGE_HOSTING_ENCRYPTION_KEY" };
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret) {
    return { key: jwtSecret, source: "JWT_SECRET" };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[image-hosting] Production environment requires IMAGE_HOSTING_ENCRYPTION_KEY or JWT_SECRET. " +
      "Please set one of these environment variables before using image hosting.",
    );
  }

  console.warn(
    "[image-hosting] Neither IMAGE_HOSTING_ENCRYPTION_KEY nor JWT_SECRET is set. " +
    "Using development fallback key. This is NOT safe for production.",
  );
  return {
    key: "nowen-note-dev-fallback-key-not-for-production",
    source: "development-fallback",
  };
}

function deriveCipherKey(): Buffer {
  const { key } = getEncryptionKeySource();
  return crypto.scryptSync(key, "nowen-image-hosting-v1", 32);
}

function encryptSecret(plain: string): string {
  if (!plain) return "";
  const key = deriveCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(encoded: string): string {
  if (!encoded || !encoded.startsWith("v1:")) return "";
  try {
    const [, ivB64, tagB64, dataB64] = encoded.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveCipherKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (error) {
    console.warn("[image-hosting] decrypt secret failed:", error);
    return "";
  }
}

function defaultPublicConfig(): ImageHostingConfigPublic {
  return {
    enabled: false,
    provider: "s3-compatible",
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    secretAccessKeySet: false,
    publicBaseUrl: "",
    pathPrefix: "images",
    usePathStyle: true,
    maxFileSizeMb: 10,
    allowedTypes: [...DEFAULT_ALLOWED_TYPES],
    updatedAt: null,
  };
}

async function readPersistedConfigAsync(): Promise<
  (ImageHostingConfig & { updatedAt: string | null }) | null
> {
  try {
    const row = await systemSettingsRepository.getAsync(SETTING_KEY);
    if (!row) return null;
    const parsed = JSON.parse(row.value || "{}") as Record<string, unknown>;
    return {
      enabled: parsed.enabled === true,
      provider: parsed.provider === "custom" ? "custom" : "s3-compatible",
      endpoint: String(parsed.endpoint || "").trim().replace(/\/+$/, ""),
      region: String(parsed.region || "auto").trim() || "auto",
      bucket: String(parsed.bucket || "").trim(),
      accessKeyId: String(parsed.accessKeyId || "").trim(),
      secretAccessKey: decryptSecret(String(parsed.secretAccessKeyEnc || "")),
      publicBaseUrl: String(parsed.publicBaseUrl || "").trim().replace(/\/+$/, ""),
      pathPrefix: String(parsed.pathPrefix || "images").trim().replace(/^\/+|\/+$/g, ""),
      usePathStyle: parsed.usePathStyle !== false,
      maxFileSizeMb: Number(parsed.maxFileSizeMb) || 10,
      allowedTypes: Array.isArray(parsed.allowedTypes)
        ? parsed.allowedTypes.map(String)
        : [...DEFAULT_ALLOWED_TYPES],
      updatedAt: row.updatedAt || null,
    };
  } catch (error) {
    console.warn("[image-hosting] read config failed:", error);
    return null;
  }
}

export async function readImageHostingConfigPublic(): Promise<ImageHostingConfigPublic> {
  const config = await readPersistedConfigAsync();
  if (!config) return defaultPublicConfig();
  return {
    enabled: config.enabled,
    provider: config.provider,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKeySet: Boolean(config.secretAccessKey),
    publicBaseUrl: config.publicBaseUrl,
    pathPrefix: config.pathPrefix,
    usePathStyle: config.usePathStyle,
    maxFileSizeMb: config.maxFileSizeMb,
    allowedTypes: config.allowedTypes,
    updatedAt: config.updatedAt,
  };
}

export async function writeImageHostingConfig(
  input: WriteImageHostingConfigInput,
): Promise<ImageHostingConfigPublic> {
  try {
    getEncryptionKeySource();
  } catch (error: any) {
    throw new Error(`Cannot save image hosting config: ${error.message}`);
  }

  const existing = await readPersistedConfigAsync();
  const secretAccessKeyEnc = input.secretAccessKey
    ? encryptSecret(input.secretAccessKey)
    : existing?.secretAccessKey
      ? encryptSecret(existing.secretAccessKey)
      : "";

  const config = {
    enabled: input.enabled,
    provider: input.provider || "s3-compatible",
    endpoint: input.endpoint.trim().replace(/\/+$/, ""),
    region: (input.region || "auto").trim() || "auto",
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKeyEnc,
    publicBaseUrl: input.publicBaseUrl.trim().replace(/\/+$/, ""),
    pathPrefix: (input.pathPrefix || "images").trim().replace(/^\/+|\/+$/g, ""),
    usePathStyle: input.usePathStyle !== false,
    maxFileSizeMb: input.maxFileSizeMb || 10,
    allowedTypes: input.allowedTypes || [...DEFAULT_ALLOWED_TYPES],
  };

  await systemSettingsRepository.setAsync(SETTING_KEY, JSON.stringify(config));
  return await readImageHostingConfigPublic();
}

export async function deleteImageHostingConfig(): Promise<ImageHostingConfigPublic> {
  await systemSettingsRepository.deleteAsync(SETTING_KEY);
  return await readImageHostingConfigPublic();
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function buildS3SignedRequest(
  method: string,
  objectKey: string,
  config: ImageHostingConfig,
  body?: Buffer,
  contentType?: string,
): { url: string; headers: Record<string, string> } {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const host = new URL(config.endpoint).host;
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const canonicalUri = `/${encodedKey}`;
  const payloadHash = sha256(body || Buffer.alloc(0));
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(Buffer.from(canonicalRequest)),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, config.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = config.usePathStyle
    ? `${config.endpoint}/${config.bucket}/${encodedKey}`
    : `${config.endpoint}/${encodedKey}`;

  const headers: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: authorization,
  };
  if (contentType) headers["Content-Type"] = contentType;
  return { url, headers };
}

function generateObjectKey(filename: string, prefix: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  const safeExtension = extension.replace(/[^a-zA-Z0-9.]/g, "");
  const parts = [prefix, year, month, `${crypto.randomUUID()}${safeExtension}`].filter(Boolean);
  return parts.join("/");
}

export async function uploadImageToHosting(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ImageUploadResult> {
  try {
    getEncryptionKeySource();
  } catch (error: any) {
    return { success: false, error: error.message, code: "ENCRYPTION_KEY_MISSING" };
  }

  const config = await readPersistedConfigAsync();
  if (!config || !config.enabled) {
    return { success: false, error: "Image hosting not enabled", code: "NOT_ENABLED" };
  }
  if (!config.allowedTypes.includes(mimeType)) {
    return { success: false, error: `Unsupported file type: ${mimeType}`, code: "INVALID_TYPE" };
  }

  const maxSize = config.maxFileSizeMb * 1024 * 1024;
  if (buffer.length > maxSize) {
    return {
      success: false,
      error: `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${config.maxFileSizeMb}MB`,
      code: "FILE_TOO_LARGE",
    };
  }

  const objectKey = generateObjectKey(filename, config.pathPrefix);
  try {
    const { url, headers } = buildS3SignedRequest("PUT", objectKey, config, buffer, mimeType);
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(buffer),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[image-hosting] S3 PUT failed: ${response.status} ${errorText}`);
      return {
        success: false,
        error: `Upload failed: HTTP ${response.status}`,
        code: "UPLOAD_FAILED",
      };
    }
    return {
      success: true,
      url: `${config.publicBaseUrl}/${objectKey}`,
      filename,
      size: buffer.length,
      mimeType,
    };
  } catch (error: any) {
    console.error("[image-hosting] upload error:", error);
    return {
      success: false,
      error: error.message || "Upload failed",
      code: "UPLOAD_ERROR",
    };
  }
}

export async function testImageHostingConfig(): Promise<{
  ok: boolean;
  url?: string;
  error?: string;
}> {
  try {
    getEncryptionKeySource();
  } catch (error: any) {
    return { ok: false, error: error.message };
  }

  const config = await readPersistedConfigAsync();
  if (!config || !config.enabled) {
    return { ok: false, error: "Image hosting not enabled" };
  }
  if (
    !config.endpoint ||
    !config.bucket ||
    !config.accessKeyId ||
    !config.secretAccessKey ||
    !config.publicBaseUrl
  ) {
    return { ok: false, error: "Configuration incomplete" };
  }

  try {
    const testPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJREFUeJztzDEBAAAIwzDAv+dhAhdOAAAA0wEA7wGzAAAAAElFTkSuQmCC",
      "base64",
    );
    const objectKey = generateObjectKey("test.png", config.pathPrefix);
    const { url, headers } = buildS3SignedRequest("PUT", objectKey, config, testPng, "image/png");
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: testPng,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        ok: false,
        error: `Upload test failed: HTTP ${response.status} ${errorText}`,
      };
    }
    return { ok: true, url: `${config.publicBaseUrl}/${objectKey}` };
  } catch (error: any) {
    return { ok: false, error: error.message || "Test failed" };
  }
}

export async function isImageHostingEnabled(): Promise<boolean> {
  const config = await readPersistedConfigAsync();
  return Boolean(
    config?.enabled &&
    config.endpoint &&
    config.bucket &&
    config.accessKeyId &&
    config.secretAccessKey &&
    config.publicBaseUrl
  );
}
