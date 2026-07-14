/**
 * 第三方图床服务
 *
 * 支持 S3 兼容对象存储（AWS S3、Cloudflare R2、MinIO 等）作为图床。
 * 图片上传后返回公开 URL，直接嵌入笔记内容。
 */

import crypto from "crypto";
import { systemSettingsRepository } from "../repositories/systemSettingsRepository";

const SETTING_KEY = "imageHosting:config";

// ====== 类型定义 ======

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
  secretAccessKey?: string; // 留空表示不修改
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

// ====== 加密工具 ======

function getEncryptionKeySource(): { key: string; source: string } {
  // 优先使用独立的图床加密密钥
  const dedicatedKey = process.env.IMAGE_HOSTING_ENCRYPTION_KEY;
  if (dedicatedKey) {
    return { key: dedicatedKey, source: "IMAGE_HOSTING_ENCRYPTION_KEY" };
  }

  // 兼容使用 JWT_SECRET
  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret) {
    return { key: jwtSecret, source: "JWT_SECRET" };
  }

  // 两者都未设置
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    throw new Error(
      "[image-hosting] Production environment requires IMAGE_HOSTING_ENCRYPTION_KEY or JWT_SECRET. " +
      "Please set one of these environment variables before using image hosting."
    );
  }

  // 开发环境允许 fallback
  console.warn(
    "[image-hosting] Neither IMAGE_HOSTING_ENCRYPTION_KEY nor JWT_SECRET is set. " +
    "Using development fallback key. This is NOT safe for production."
  );
  return { key: "nowen-note-dev-fallback-key-not-for-production", source: "development-fallback" };
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
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(encoded: string): string {
  if (!encoded || !encoded.startsWith("v1:")) return "";
  try {
    const [, ivB64, tagB64, dataB64] = encoded.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveCipherKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch (err) {
    console.warn("[image-hosting] decrypt secret failed:", err);
    return "";
  }
}

// ====== 配置读写 ======

function readPersistedConfig(): (ImageHostingConfig & { updatedAt: string | null }) | null {
  try {
    const row = systemSettingsRepository.get(SETTING_KEY);
    if (!row) return null;
    const parsed = JSON.parse(row.value || "{}") as Record<string, any>;
    return {
      enabled: parsed.enabled === true,
      provider: parsed.provider || "s3-compatible",
      endpoint: String(parsed.endpoint || "").trim().replace(/\/+$/, ""),
      region: String(parsed.region || "auto").trim() || "auto",
      bucket: String(parsed.bucket || "").trim(),
      accessKeyId: String(parsed.accessKeyId || "").trim(),
      secretAccessKey: decryptSecret(parsed.secretAccessKeyEnc || ""),
      publicBaseUrl: String(parsed.publicBaseUrl || "").trim().replace(/\/+$/, ""),
      pathPrefix: String(parsed.pathPrefix || "images").trim().replace(/^\/+|\/+$/g, ""),
      usePathStyle: parsed.usePathStyle !== false,
      maxFileSizeMb: Number(parsed.maxFileSizeMb) || 10,
      allowedTypes: Array.isArray(parsed.allowedTypes) ? parsed.allowedTypes : ["image/png", "image/jpeg", "image/gif", "image/webp"],
      updatedAt: row.updatedAt || null,
    };
  } catch (err) {
    console.warn("[image-hosting] read config failed:", err);
    return null;
  }
}

export function readImageHostingConfigPublic(): ImageHostingConfigPublic {
  const cfg = readPersistedConfig();
  if (!cfg) {
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
      allowedTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
      updatedAt: null,
    };
  }
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKeySet: !!cfg.secretAccessKey,
    publicBaseUrl: cfg.publicBaseUrl,
    pathPrefix: cfg.pathPrefix,
    usePathStyle: cfg.usePathStyle,
    maxFileSizeMb: cfg.maxFileSizeMb,
    allowedTypes: cfg.allowedTypes,
    updatedAt: cfg.updatedAt,
  };
}

export function writeImageHostingConfig(input: WriteImageHostingConfigInput): ImageHostingConfigPublic {
  // 验证加密密钥可用性（生产环境会抛出错误）
  try {
    getEncryptionKeySource();
  } catch (err: any) {
    throw new Error(`Cannot save image hosting config: ${err.message}`);
  }

  const existing = readPersistedConfig();
  const secretAccessKey = input.secretAccessKey
    ? encryptSecret(input.secretAccessKey)
    : existing?.secretAccessKey ? encryptSecret(existing.secretAccessKey) : "";

  const config = {
    enabled: input.enabled,
    provider: input.provider || "s3-compatible",
    endpoint: input.endpoint.trim().replace(/\/+$/, ""),
    region: (input.region || "auto").trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKeyEnc: secretAccessKey,
    publicBaseUrl: input.publicBaseUrl.trim().replace(/\/+$/, ""),
    pathPrefix: (input.pathPrefix || "images").trim().replace(/^\/+|\/+$/g, ""),
    usePathStyle: input.usePathStyle !== false,
    maxFileSizeMb: input.maxFileSizeMb || 10,
    allowedTypes: input.allowedTypes || ["image/png", "image/jpeg", "image/gif", "image/webp"],
  };

  systemSettingsRepository.set(SETTING_KEY, JSON.stringify(config));

  return readImageHostingConfigPublic();
}

export function deleteImageHostingConfig(): ImageHostingConfigPublic {
  systemSettingsRepository.delete(SETTING_KEY);
  return readImageHostingConfigPublic();
}

// ====== S3 签名上传 ======

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function buildS3SignedRequest(
  method: string,
  objectKey: string,
  cfg: ImageHostingConfig,
  body?: Buffer,
  contentType?: string,
): { url: string; headers: Record<string, string> } {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const host = new URL(cfg.endpoint).host;
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const canonicalUri = `/${encodedKey}`;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${sha256(body || Buffer.alloc(0))}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const payloadHash = sha256(body || Buffer.alloc(0));

  const canonicalQueryString = "";
  const canonicalRequest = [
    method, canonicalUri, canonicalQueryString,
    canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, credentialScope,
    sha256(Buffer.from(canonicalRequest)),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, cfg.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = cfg.usePathStyle
    ? `${cfg.endpoint}/${cfg.bucket}/${encodedKey}`
    : `${cfg.endpoint}/${encodedKey}`;

  const headers: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "Authorization": authorization,
  };
  if (contentType) headers["Content-Type"] = contentType;

  return { url, headers };
}

// ====== 上传函数 ======

function generateObjectKey(filename: string, prefix: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "");
  const uuid = crypto.randomUUID();
  const parts = [prefix, year, month, `${uuid}${safeExt}`].filter(Boolean);
  return parts.join("/");
}

export async function uploadImageToHosting(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ImageUploadResult> {
  // 验证加密密钥可用性（生产环境会抛出错误）
  try {
    getEncryptionKeySource();
  } catch (err: any) {
    return { success: false, error: err.message, code: "ENCRYPTION_KEY_MISSING" };
  }

  const cfg = readPersistedConfig();
  if (!cfg || !cfg.enabled) {
    return { success: false, error: "Image hosting not enabled", code: "NOT_ENABLED" };
  }

  // 校验文件类型
  if (!cfg.allowedTypes.includes(mimeType)) {
    return { success: false, error: `Unsupported file type: ${mimeType}`, code: "INVALID_TYPE" };
  }

  // 校验文件大小
  const maxSize = cfg.maxFileSizeMb * 1024 * 1024;
  if (buffer.length > maxSize) {
    return { success: false, error: `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${cfg.maxFileSizeMb}MB`, code: "FILE_TOO_LARGE" };
  }

  // 生成对象键
  const objectKey = generateObjectKey(filename, cfg.pathPrefix);

  try {
    // 构建签名请求
    const { url, headers } = buildS3SignedRequest("PUT", objectKey, cfg, buffer, mimeType);

    // 上传
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.error(`[image-hosting] S3 PUT failed: ${res.status} ${errorText}`);
      return { success: false, error: `Upload failed: HTTP ${res.status}`, code: "UPLOAD_FAILED" };
    }

    // 生成公开 URL
    const publicUrl = `${cfg.publicBaseUrl}/${objectKey}`;

    return {
      success: true,
      url: publicUrl,
      filename,
      size: buffer.length,
      mimeType,
    };
  } catch (err: any) {
    console.error("[image-hosting] upload error:", err);
    return { success: false, error: err.message || "Upload failed", code: "UPLOAD_ERROR" };
  }
}

// ====== 测试连接 ======

export async function testImageHostingConfig(): Promise<{ ok: boolean; url?: string; error?: string }> {
  // 验证加密密钥可用性（生产环境会抛出错误）
  try {
    getEncryptionKeySource();
  } catch (err: any) {
    return { ok: false, error: err.message };
  }

  const cfg = readPersistedConfig();
  if (!cfg || !cfg.enabled) {
    return { ok: false, error: "Image hosting not enabled" };
  }

  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.publicBaseUrl) {
    return { ok: false, error: "Configuration incomplete" };
  }

  try {
    // 上传一个 1x1 透明 PNG 测试
    const testPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJREFUeJztzDEBAAAIwzDAv+dhAhdOAAAA0wEA7wGzAAAAAElFTkSuQmCC",
      "base64"
    );
    const objectKey = generateObjectKey("test.png", cfg.pathPrefix);
    const { url, headers } = buildS3SignedRequest("PUT", objectKey, cfg, testPng, "image/png");

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: testPng,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return { ok: false, error: `Upload test failed: HTTP ${res.status} ${errorText}` };
    }

    const publicUrl = `${cfg.publicBaseUrl}/${objectKey}`;
    return { ok: true, url: publicUrl };
  } catch (err: any) {
    return { ok: false, error: err.message || "Test failed" };
  }
}

// ====== 检查是否启用 ======

export function isImageHostingEnabled(): boolean {
  const cfg = readPersistedConfig();
  return !!cfg && cfg.enabled && !!cfg.endpoint && !!cfg.bucket && !!cfg.accessKeyId && !!cfg.secretAccessKey && !!cfg.publicBaseUrl;
}
