import { Hono } from "hono";
import { isSystemAdmin } from "../middleware/acl";
import { invalidateFilesQueryDebugCache } from "./files";
import { systemSettingsRepository } from "../repositories";
import {
  resolvePublicWebOriginSettingUpdate,
  syncRuntimePublicWebOriginSetting,
} from "../lib/public-web-origin";
import systemUpdateRouter from "./system-update";
import importBatchesRouter from "./import-batches";

const settings = new Hono();

export interface SiteSettings {
  site_title: string;
  site_favicon: string;
  /** ICP 备案号由 Docker/运行时环境变量 NOWEN_ICP_BEIAN 驱动，设置页不可编辑。 */
  site_icp_beian: string;
  /** 访客最终打开的公开 Web 根地址；空串表示沿用当前浏览器 origin。 */
  site_public_web_origin: string;
  /** 地址来源，仅用于 UI 解释：settings / environment / current。 */
  site_public_web_origin_source: string;
  editor_font_family: string;
  /** @deprecated v6 起弃用，个人空间导出开关已下沉为 users.personalExportEnabled。 */
  feature_personal_export_enabled: string;
  /** @deprecated 同上。 */
  feature_personal_import_enabled: string;
  /** 调试开关：是否在 GET /api/files 列表请求中打印 query 解析详情。 */
  debug_files_query: string;
  /** 是否允许服务端直接提供 Web UI 页面。 */
  web_ui_enabled: string;
}

const DEFAULTS: SiteSettings = {
  site_title: "nowen-note",
  site_favicon: "",
  site_icp_beian: "",
  site_public_web_origin: "",
  site_public_web_origin_source: "current",
  editor_font_family: "",
  feature_personal_export_enabled: "true",
  feature_personal_import_enabled: "true",
  debug_files_query: "false",
  web_ui_enabled: "true",
};

try {
  syncRuntimePublicWebOriginSetting();
} catch (error) {
  console.warn("[settings] failed to initialize PUBLIC_WEB_ORIGIN:", error);
}

function readSettings(): Record<string, string> {
  const rows = systemSettingsRepository.getByPrefixes([
    "site_",
    "editor_",
    "feature_",
    "debug_",
  ]);
  const webUiSetting = systemSettingsRepository.get("web_ui_enabled");

  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) result[row.key] = row.value;
  if (webUiSetting) result[webUiSetting.key] = webUiSetting.value;
  return result;
}

settings.get("/", (c) => c.json(readSettings()));

settings.put("/", async (c) => {
  const body = await c.req.json() as Partial<SiteSettings>;
  const userId = c.req.header("X-User-Id") || "";

  const wantsSiteIdentity =
    body.site_title !== undefined ||
    body.site_favicon !== undefined ||
    body.site_public_web_origin !== undefined;
  if (wantsSiteIdentity && !isSystemAdmin(userId)) {
    return c.json({ error: "仅管理员可修改该设置", code: "FORBIDDEN" }, 403);
  }

  const wantsDebugFlag = body.debug_files_query !== undefined;
  const wantsWebUiFlag = body.web_ui_enabled !== undefined;
  if ((wantsDebugFlag || wantsWebUiFlag) && !isSystemAdmin(userId)) {
    return c.json({ error: "仅管理员可修改系统开关", code: "FORBIDDEN" }, 403);
  }

  const entries: Array<{ key: string; value: string }> = [];
  if (body.site_title !== undefined) {
    entries.push({ key: "site_title", value: body.site_title.trim().slice(0, 20) });
  }
  if (body.site_favicon !== undefined) {
    entries.push({ key: "site_favicon", value: body.site_favicon });
  }
  if (body.site_public_web_origin !== undefined) {
    const resolved = resolvePublicWebOriginSettingUpdate(body.site_public_web_origin);
    if ("error" in resolved) {
      return c.json({ error: resolved.error, code: "INVALID_PUBLIC_WEB_ORIGIN" }, 400);
    }
    entries.push(...resolved.entries);
  }
  if (body.editor_font_family !== undefined) {
    entries.push({ key: "editor_font_family", value: body.editor_font_family });
  }
  if (body.debug_files_query !== undefined) {
    const raw = body.debug_files_query as unknown;
    entries.push({
      key: "debug_files_query",
      value: raw === true || raw === "true" || raw === 1 || raw === "1" ? "true" : "false",
    });
    invalidateFilesQueryDebugCache();
  }
  if (body.web_ui_enabled !== undefined) {
    const raw = body.web_ui_enabled as unknown;
    entries.push({
      key: "web_ui_enabled",
      value: raw === true || raw === "true" || raw === 1 || raw === "1" ? "true" : "false",
    });
  }

  if (entries.length > 0) systemSettingsRepository.setMany(entries);
  return c.json(readSettings());
});

// 管理员专用 Docker 在线升级控制面。挂在 settings 路由下可复用现有 JWT 中间件，
// 子路由自身再叠加 requireAdmin、sudo、同源交互头和速率限制。
settings.route("/system-update", systemUpdateRouter);
// Round-trip 导入批次报告属于当前登录用户的数据，不要求管理员权限。
settings.route("/import-batches", importBatchesRouter);

export default settings;
