import { Hono } from "hono";
import { isSystemAdmin } from "../middleware/acl";
import { systemSettingsRepository } from "../repositories/systemSettingsRepository";

const app = new Hono();
const CONFIG_KEY = "imageHosting:config";
const FALLBACK_KEY = "imageHosting:fallbackToLocal";

function readLegacyConfig() {
  let row: { value: string; updatedAt?: string | null } | undefined;
  try {
    row = systemSettingsRepository.get(CONFIG_KEY);
  } catch (error) {
    console.warn("[image-hosting-retired] failed to read legacy config", error);
  }

  let parsed: Record<string, unknown> = {};
  if (row?.value) {
    try {
      parsed = JSON.parse(row.value) as Record<string, unknown>;
    } catch (error) {
      console.warn("[image-hosting-retired] invalid legacy config JSON", error);
    }
  }

  const readString = (key: string, fallback = "") =>
    typeof parsed[key] === "string" ? String(parsed[key]).trim() : fallback;

  return {
    retired: true,
    configured: Boolean(row),
    enabled: false,
    legacyEnabled: parsed.enabled === true,
    provider: readString("provider", "s3-compatible"),
    endpoint: readString("endpoint").replace(/\/+$/, ""),
    region: readString("region", "auto") || "auto",
    bucket: readString("bucket"),
    accessKeyId: readString("accessKeyId"),
    secretAccessKeySet: Boolean(parsed.secretAccessKeyEnc || parsed.secretAccessKey),
    publicBaseUrl: readString("publicBaseUrl").replace(/\/+$/, ""),
    pathPrefix: readString("pathPrefix", "images").replace(/^\/+|\/+$/g, ""),
    usePathStyle: parsed.usePathStyle !== false,
    maxFileSizeMb: Number(parsed.maxFileSizeMb) || 10,
    allowedTypes: Array.isArray(parsed.allowedTypes)
      ? parsed.allowedTypes
      : ["image/png", "image/jpeg", "image/gif", "image/webp"],
    fallbackToLocal: true,
    updatedAt: row?.updatedAt || null,
  };
}

function requireAdmin(c: any): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  if (isSystemAdmin(userId)) return null;
  return c.json({ error: "需要管理员权限", code: "FORBIDDEN" }, 403);
}

function retiredResponse(c: any) {
  return c.json(
    {
      error: "第三方图床已经退役。请使用 Nowen 附件存储，并在设置中迁移历史图床图片。",
      code: "IMAGE_HOSTING_RETIRED",
      retired: true,
    },
    410,
  );
}

/**
 * 旧配置只读接口。
 *
 * 保留 publicBaseUrl/pathPrefix 等非敏感元数据，是为了让管理员把历史公开图片链接
 * 批量迁移为 Nowen 附件。这里不再解密、返回或使用任何第三方存储密钥。
 */
app.get("/config", (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  return c.json(readLegacyConfig());
});

/** 禁止重新开启或修改第三方图床。 */
app.put("/config", (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  return retiredResponse(c);
});

/**
 * 删除本机保存的旧配置。
 * 不会访问或删除第三方 Bucket 中的任何对象。
 */
app.delete("/config", (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  systemSettingsRepository.deleteMany([CONFIG_KEY, FALLBACK_KEY]);
  return c.json(readLegacyConfig());
});

app.post("/test", (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  return retiredResponse(c);
});

/** 旧客户端即使直接调用上传接口，也不会再产生新的外部图床链接。 */
app.post("/upload", (c) => retiredResponse(c));

/** 所有客户端都会得到关闭状态，从上传入口统一走 Nowen 附件。 */
app.get("/status", (c) =>
  c.json({
    enabled: false,
    fallbackToLocal: true,
    retired: true,
  }),
);

export default app;
