/**
 * 第三方图床路由
 *
 * 提供图床配置管理、测试连接、图片上传接口。
 */

import { Hono } from "hono";
import {
  readImageHostingConfigPublic,
  writeImageHostingConfig,
  deleteImageHostingConfig,
  testImageHostingConfig,
  uploadImageToHosting,
  isImageHostingEnabled,
  type WriteImageHostingConfigInput,
} from "../services/image-hosting";
import { isSystemAdmin } from "../middleware/acl";

const app = new Hono();

const ALLOWED_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * GET /api/image-hosting/config
 * 读取脱敏配置
 */
app.get("/config", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  // 只有管理员可以查看配置
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }
  return c.json(readImageHostingConfigPublic());
});

/**
 * PUT /api/image-hosting/config
 * 保存配置
 */
app.put("/config", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }

  const body = await c.req.json();
  const input: WriteImageHostingConfigInput = {
    enabled: body.enabled === true,
    provider: body.provider || "s3-compatible",
    endpoint: body.endpoint || "",
    region: body.region || "auto",
    bucket: body.bucket || "",
    accessKeyId: body.accessKeyId || "",
    secretAccessKey: body.secretAccessKey || undefined,
    publicBaseUrl: body.publicBaseUrl || "",
    pathPrefix: body.pathPrefix || "images",
    usePathStyle: body.usePathStyle !== false,
    maxFileSizeMb: body.maxFileSizeMb || 10,
    allowedTypes: body.allowedTypes || ["image/png", "image/jpeg", "image/gif", "image/webp"],
  };

  const result = writeImageHostingConfig(input);
  return c.json(result);
});

/**
 * DELETE /api/image-hosting/config
 * 删除配置
 */
app.delete("/config", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }
  return c.json(deleteImageHostingConfig());
});

/**
 * POST /api/image-hosting/test
 * 测试配置是否可用
 */
app.post("/test", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }

  const result = await testImageHostingConfig();
  return c.json(result);
});

/**
 * POST /api/image-hosting/upload
 * 上传图片到第三方图床
 */
app.post("/upload", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) {
    return c.json({ error: "未登录", code: "UNAUTHORIZED" }, 401);
  }

  // 检查图床是否启用
  if (!isImageHostingEnabled()) {
    return c.json({ error: "第三方图床未启用", code: "NOT_ENABLED" }, 400);
  }

  // 解析 multipart form data
  const body = await c.req.parseBody();
  const file = body["file"];
  const source = (body["source"] as string) || "editor";

  if (!file || !(file instanceof File)) {
    return c.json({ error: "未上传文件", code: "NO_FILE" }, 400);
  }

  // 校验文件类型
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) {
    return c.json({ error: `不支持的文件类型: ${mime}`, code: "INVALID_TYPE" }, 400);
  }

  // 校验文件大小
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `文件过大（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）`, code: "FILE_TOO_LARGE" }, 400);
  }

  // 读取文件内容
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 上传到图床
  const result = await uploadImageToHosting(buffer, file.name, mime);

  if (!result.success) {
    return c.json(result, 500);
  }

  return c.json({
    success: true,
    url: result.url,
    filename: result.filename,
    size: result.size,
    mimeType: result.mimeType,
    uploadSource: "third-party-image-hosting",
  });
});

/**
 * GET /api/image-hosting/status
 * 检查图床是否启用（公开接口，不需要管理员权限）
 */
app.get("/status", (c) => {
  return c.json({ enabled: isImageHostingEnabled() });
});

export default app;
