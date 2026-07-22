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
import {
  deleteImageHostingFallbackPolicy,
  readImageHostingFallbackToLocal,
  writeImageHostingFallbackToLocal,
} from "../services/image-hosting-policy";
import { isSystemAdmin } from "../middleware/acl";

const app = new Hono();

const ALLOWED_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024;

async function readPublicConfigWithPolicy() {
  const [config, fallbackToLocal] = await Promise.all([
    readImageHostingConfigPublic(),
    readImageHostingFallbackToLocal(),
  ]);
  return { ...config, fallbackToLocal };
}

app.get("/config", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }
  return c.json(await readPublicConfigWithPolicy());
});

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

  await Promise.all([
    writeImageHostingConfig(input),
    writeImageHostingFallbackToLocal(body.fallbackToLocal !== false),
  ]);
  return c.json(await readPublicConfigWithPolicy());
});

app.delete("/config", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }
  await Promise.all([
    deleteImageHostingConfig(),
    deleteImageHostingFallbackPolicy(),
  ]);
  return c.json(await readPublicConfigWithPolicy());
});

app.post("/test", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
  }
  return c.json(await testImageHostingConfig());
});

app.post("/upload", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) {
    return c.json({ error: "未登录", code: "UNAUTHORIZED" }, 401);
  }

  if (!(await isImageHostingEnabled())) {
    return c.json({ error: "第三方图床未启用", code: "NOT_ENABLED" }, 400);
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  const source = (body["source"] as string) || "editor";

  if (!file || !(file instanceof File)) {
    return c.json({ error: "未上传文件", code: "NO_FILE" }, 400);
  }

  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) {
    return c.json({ error: `不支持的文件类型: ${mime}`, code: "INVALID_TYPE" }, 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `文件过大（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）`, code: "FILE_TOO_LARGE" }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await uploadImageToHosting(buffer, file.name, mime);
  if (!result.success) return c.json(result, 500);

  return c.json({
    success: true,
    url: result.url,
    filename: result.filename,
    size: result.size,
    mimeType: result.mimeType,
    uploadSource: "third-party-image-hosting",
    source,
  });
});

app.get("/status", async (c) => {
  const [enabled, fallbackToLocal] = await Promise.all([
    isImageHostingEnabled(),
    readImageHostingFallbackToLocal(),
  ]);
  return c.json({ enabled, fallbackToLocal });
});

export default app;
