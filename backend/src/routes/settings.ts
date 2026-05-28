import { Hono } from "hono";
import { getDb } from "../db/schema";
import { isSystemAdmin } from "../middleware/acl";
import { invalidateFilesQueryDebugCache } from "./files";

const settings = new Hono();

export interface SiteSettings {
  site_title: string;
  site_favicon: string;
  editor_font_family: string;
  /**
   * @deprecated v6 起弃用——个人空间导出开关已下沉为 users.personalExportEnabled，
   * 由管理员在「用户管理 → 编辑用户」里逐个切换。
   *
   * 该键仍然可能出现在存量库的 system_settings 表里，但：
   *   - GET /api/settings 会把它作为透传字段下发（DEFAULTS 为 "true"），
   *     供旧前端降级兼容；新前端（useSiteSettings）已不再读。
   *   - PUT /api/settings 不再接受它——即使 body 里携带也会被忽略。
   *   - routes/export.ts 的闸门已切换为读 users 行，不再看这里。
   */
  feature_personal_export_enabled: string;
  /** @deprecated 同上，参考 {@link SiteSettings.feature_personal_export_enabled} */
  feature_personal_import_enabled: string;
  /**
   * 调试开关：是否在 GET /api/files 列表请求中打印 query 解析详情（raw / parsed
   * / whereSql / paramCount）。专为排查 query 大小写 / 拼写陷阱（参考 v12
   * myUploads 字面量血泪）设计。
   *
   * 值为 "true" / "false" 字符串。仅系统管理员可写——开启后日志量与请求成正比，
   * 普通用户不应能切换；env `DEBUG_FILES_QUERY=1` 仍作为运维侧旁路开关，二者
   * 任一为 true 即生效（运维与运行时设置互不阻塞）。
   */
  debug_files_query: string;
  /** 是否允许服务端直接提供 Web UI 页面。关闭后 /api/* 保留，非 API 页面返回禁用提示。 */
  web_ui_enabled: string;
}

const DEFAULTS: SiteSettings = {
  site_title: "nowen-note",
  site_favicon: "",
  editor_font_family: "",
  // 仅作为"旧前端拿到的透传兜底值"存在；新前端忽略。
  feature_personal_export_enabled: "true",
  feature_personal_import_enabled: "true",
  debug_files_query: "false",
  web_ui_enabled: "false",
};

// 获取所有站点设置
settings.get("/", (c) => {
  const db = getDb();
  // 同时下发 feature_* 旧键以兼容未升级的旧客户端；新客户端不再消费这两个值。
  // debug_* 系列是运行时调试开关（如 debug_files_query），下发给前端以便管理员
  // 在「设置 → 开发者」面板里看到当前状态；非管理员前端会自行忽略。
  const rows = db
    .prepare(
      "SELECT key, value FROM system_settings WHERE key LIKE 'site_%' OR key LIKE 'editor_%' OR key LIKE 'feature_%' OR key LIKE 'debug_%' OR key = 'web_ui_enabled'",
    )
    .all() as { key: string; value: string }[];
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return c.json(result);
});

// 更新站点设置
//
// 字段级权限：
//   - site_title / site_favicon 是「站点标识」，全站所有用户共享同一份，
//     允许任何登录用户修改会导致普通成员把整个站点的品牌改掉 —— 因此只允许系统管理员写。
//   - editor_font_family 是字体偏好，目前也是站点级（system_settings 单表共享），
//     按现状保留为所有登录用户均可改；后续若要做"个人字体"，需要迁移到 user_preferences。
//   - feature_personal_export_enabled / feature_personal_import_enabled 已废弃
//     （v6 下沉为 users 表 per-user 字段），即使 body 里带了也静默丢弃。
//
// 设计权衡：没有把 requireAdmin 挂在整条路由上，因为这样会把字体切换也连带锁死。
// 改成在 handler 里按 body 字段判断，普通用户只要不带 site_title / site_favicon 就放行。
settings.put("/", async (c) => {
  const body = await c.req.json() as Partial<SiteSettings>;
  const userId = c.req.header("X-User-Id") || "";

  const wantsSiteIdentity =
    body.site_title !== undefined || body.site_favicon !== undefined;
  if (wantsSiteIdentity && !isSystemAdmin(userId)) {
    return c.json(
      { error: "仅管理员可修改该设置", code: "FORBIDDEN" },
      403,
    );
  }

  // debug_* / web_ui_enabled 系列是站点级运行时开关，影响所有用户的请求行为
  // （日志量、页面可访问性、可能的性能开销），普通用户不能切——单独再做一次闸门。
  const wantsDebugFlag = body.debug_files_query !== undefined;
  const wantsWebUiFlag = body.web_ui_enabled !== undefined;
  if ((wantsDebugFlag || wantsWebUiFlag) && !isSystemAdmin(userId)) {
    return c.json(
      { error: "仅管理员可修改系统开关", code: "FORBIDDEN" },
      403,
    );
  }

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `);

  const tx = db.transaction(() => {
    if (body.site_title !== undefined) {
      upsert.run("site_title", body.site_title.trim().slice(0, 20));
    }
    if (body.site_favicon !== undefined) {
      upsert.run("site_favicon", body.site_favicon);
    }
    if (body.editor_font_family !== undefined) {
      upsert.run("editor_font_family", body.editor_font_family);
    }
    if (body.debug_files_query !== undefined) {
      // 归一化成 "true" / "false"——前端可能传 boolean，也可能传字符串
      const raw = body.debug_files_query as unknown;
      const normalized =
        raw === true || raw === "true" || raw === 1 || raw === "1"
          ? "true"
          : "false";
      upsert.run("debug_files_query", normalized);
      // files.ts 内部缓存 30s，写入后主动失效一次，让下一个请求立即读到新值
      invalidateFilesQueryDebugCache();
    }
    if (body.web_ui_enabled !== undefined) {
      const raw = body.web_ui_enabled as unknown;
      const normalized =
        raw === true || raw === "true" || raw === 1 || raw === "1"
          ? "true"
          : "false";
      upsert.run("web_ui_enabled", normalized);
    }
    // feature_personal_*_enabled 已废弃：即使传了也不再写库，避免跟 per-user
    // 字段互相遮蔽。要修改请调 PATCH /api/users/:id。
  });
  tx();

  // 返回更新后的全部设置
  const rows = db
    .prepare(
      "SELECT key, value FROM system_settings WHERE key LIKE 'site_%' OR key LIKE 'editor_%' OR key LIKE 'feature_%' OR key LIKE 'debug_%' OR key = 'web_ui_enabled'",
    )
    .all() as { key: string; value: string }[];
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return c.json(result);
});

export default settings;
