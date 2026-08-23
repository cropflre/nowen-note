import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import crypto from "node:crypto";
import { isSystemAdmin, requireAdmin } from "../middleware/acl.js";
import { getPluginService } from "../plugins/pluginService.js";

const pluginsRouter = new Hono();

function userId(c: any): string {
  return c.req.header("X-User-Id") || "";
}

function errorResponse(c: any, error: unknown) {
  const coded = error as Error & { code?: string; executionId?: string };
  const status = coded.code === "PLUGIN_NOT_FOUND" || coded.code === "PLUGIN_ACTION_NOT_FOUND" ? 404
    : coded.code === "RESOURCE_FORBIDDEN" || coded.code === "PLUGIN_PERMISSION_DENIED" ? 403
      : coded.code === "PLUGIN_TIMEOUT" ? 408 : 400;
  return c.json({ success: false, error: coded.message || String(error), code: coded.code || "PLUGIN_ERROR", executionId: coded.executionId }, status as any);
}

pluginsRouter.get("/", (c) => {
  const actor = userId(c);
  return c.json(getPluginService().list(isSystemAdmin(actor)));
});

pluginsRouter.get("/actions", (c) => c.json(getPluginService().listActions()));
pluginsRouter.get("/contributions", (c) => c.json(getPluginService().contributions()));
pluginsRouter.get("/ecosystem/sources", (c) => c.json(getPluginService().ecosystem.listSources()));
pluginsRouter.put("/ecosystem/sources", requireAdmin, async (c) => {
  try { return c.json(getPluginService().ecosystem.upsertSource(await c.req.json())); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.get("/ecosystem/catalog", async (c) => {
  try { return c.json(await getPluginService().ecosystem.index(String(c.req.query("source") || "official-v2"))); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.post("/ecosystem/install", requireAdmin, async (c) => {
  try { const body = await c.req.json() as any; return c.json({ success: true, plugin: await getPluginService().installFromEcosystem(String(body.sourceId || "official-v2"), String(body.pluginId || ""), body.version, userId(c)) }, 201); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.get("/ecosystem/updates", requireAdmin, async (c) => {
  try { return c.json(await getPluginService().checkUpdates(String(c.req.query("source") || "official-v2"))); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.post("/ecosystem/update", requireAdmin, async (c) => {
  try { const body = await c.req.json() as any; return c.json({ success: true, plugin: await getPluginService().applyUpdate(String(body.sourceId || "official-v2"), String(body.pluginId || ""), body.version, userId(c), body.confirmed === true) }); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.get("/policy", requireAdmin, (c) => c.json(getPluginService().policy.get()));
pluginsRouter.put("/policy", requireAdmin, async (c) => {
  try { return c.json(getPluginService().policy.set(await c.req.json(), userId(c))); } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.post("/install", requireAdmin, bodyLimit({
  maxSize: 21 * 1024 * 1024,
  onError: (c) => c.json({ error: "插件上传请求不能超过 21MB", code: "PLUGIN_UPLOAD_TOO_LARGE" }, 413),
}), async (c) => {
  try {
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!(upload instanceof File)) return c.json({ error: "请上传 file 字段中的 .nowen-plugin 文件" }, 400);
    if (!upload.name.endsWith(".nowen-plugin")) return c.json({ error: "文件扩展名必须是 .nowen-plugin" }, 400);
    const record = await getPluginService().install(Buffer.from(await upload.arrayBuffer()), userId(c));
    return c.json({ success: true, plugin: record }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginsRouter.get("/developer-mode", requireAdmin, (c) => c.json({ enabled: getPluginService().isDeveloperModeEnabled(), available: getPluginService().isDeveloperModeAvailable() }));
pluginsRouter.put("/developer-mode", requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    getPluginService().setDeveloperMode(body.enabled === true);
    return c.json({ success: true, enabled: body.enabled === true });
  } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.post("/dev/load", requireAdmin, async (c) => {
  try {
    const body = await c.req.json() as { directory?: string };
    const plugin = await getPluginService().loadDevelopmentDirectory(String(body.directory || ""), userId(c));
    return c.json({ success: true, plugin }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginsRouter.get("/registry/sources", (c) => c.json(getPluginService().community.listSources()));
pluginsRouter.put("/registry/sources", requireAdmin, async (c) => {
  try {
    const body = await c.req.json() as { sources?: Array<{ id: string; name: string; url: string }> };
    return c.json(getPluginService().community.setSources(Array.isArray(body.sources) ? body.sources : []));
  } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.get("/registry/catalog", async (c) => {
  try { return c.json(await getPluginService().community.catalog(c.req.query("source") || "official")); }
  catch (error) { return errorResponse(c, error); }
});
pluginsRouter.post("/registry/install", requireAdmin, async (c) => {
  try {
    const body = await c.req.json() as { sourceId?: string; pluginId?: string; version?: string };
    const plugin = await getPluginService().installFromRegistry(
      String(body.sourceId || "official"), String(body.pluginId || ""), body.version, userId(c),
    );
    return c.json({ success: true, plugin }, 201);
  } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.get("/:id/connections", (c) => {
  try { return c.json(getPluginService().connections(c.req.param("id"), userId(c))); }
  catch (error) { return errorResponse(c, error); }
});
pluginsRouter.get("/:id/settings", (c) => {
  try { return c.json(getPluginService().getSettings(c.req.param("id"), userId(c))); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.put("/:id/settings", async (c) => {
  try { return c.json(getPluginService().setSettings(c.req.param("id"), userId(c), await c.req.json())); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.post("/:id/automation-templates/:templateId/install", async (c) => {
  try { return c.json({ success: true, workflow: await getPluginService().installAutomationTemplate(c.req.param("id"), c.req.param("templateId"), userId(c)) }, 201); } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.put("/:id/update-policy", requireAdmin, async (c) => {
  try { const body = await c.req.json() as any; return c.json(getPluginService().setUpdatePolicy(c.req.param("id"), body.policy, body.pinnedVersion)); } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.get("/:id/versions", requireAdmin, (c) => {
  try { return c.json(getPluginService().listVersions(c.req.param("id"))); }
  catch (error) { return errorResponse(c, error); }
});

pluginsRouter.post("/:id/rollback", requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { version?: string };
    return c.json({ success: true, plugin: await getPluginService().rollback(c.req.param("id"), body.version) });
  } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.get("/:id", (c) => {
  try {
    const plugin = getPluginService().get(c.req.param("id"));
    if (!isSystemAdmin(userId(c)) && plugin.status !== "enabled") return c.json({ error: "插件不可用", code: "PLUGIN_NOT_ENABLED" }, 404);
    return c.json(plugin);
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginsRouter.put("/:id/permissions", requireAdmin, async (c) => {
  try {
    const body = await c.req.json() as { granted?: string[] };
    return c.json({ success: true, ...getPluginService().grantPermissions(c.req.param("id"), Array.isArray(body.granted) ? body.granted : [], userId(c)) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

for (const [action, handler] of [
  ["enable", (id: string) => getPluginService().enable(id)],
  ["disable", (id: string) => getPluginService().disable(id)],
  ["reload", (id: string) => getPluginService().reload(id)],
] as const) {
  pluginsRouter.post(`/:id/${action}`, requireAdmin, async (c) => {
    try { return c.json({ success: true, plugin: await handler(c.req.param("id")) }); }
    catch (error) { return errorResponse(c, error); }
  });
}

pluginsRouter.delete("/:id", requireAdmin, async (c) => {
  try {
    await getPluginService().uninstall(c.req.param("id"));
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginsRouter.get("/:id/executions", (c) => {
  const actor = userId(c);
  const rows = getPluginService().executions.list(c.req.param("id"), isSystemAdmin(actor) ? undefined : actor, Number(c.req.query("limit")) || 100);
  return c.json(rows);
});

pluginsRouter.get("/:id/logs", requireAdmin, (c) => {
  const rows = getPluginService().executions.list(c.req.param("id"), undefined, 100);
  return c.json(rows.map((row) => ({ executionId: row.id, startedAt: row.startedAt, status: row.status, logTail: row.logTail })));
});

pluginsRouter.get("/:id/secrets", (c) => {
  try {
    getPluginService().get(c.req.param("id"));
    return c.json(getPluginService().secrets.list(c.req.param("id"), userId(c)));
  } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.put("/:id/secrets/:name", async (c) => {
  try {
    const body = await c.req.json() as { value?: string };
    getPluginService().secrets.set(c.req.param("id"), userId(c), c.req.param("name"), String(body.value || ""));
    return c.json({ success: true });
  } catch (error) { return errorResponse(c, error); }
});

pluginsRouter.delete("/:id/secrets/:name", (c) => {
  getPluginService().secrets.remove(c.req.param("id"), userId(c), c.req.param("name"));
  return c.json({ success: true });
});

pluginsRouter.post("/:id/actions/:actionId/execute", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { input?: unknown; workspaceId?: string | null };
    const plugin = getPluginService().get(c.req.param("id"));
    const action = (plugin.actions as Array<{ id: string; execution?: string }>).find((item) => item.id === c.req.param("actionId"));
    if (action?.execution === "background") {
      const executionId = crypto.randomUUID();
      void getPluginService().execute(c.req.param("id"), c.req.param("actionId"), userId(c), body.workspaceId || null, body.input || {}, executionId).catch(() => undefined);
      return c.json({ success: true, executionId, status: "queued" }, 202);
    }
    const execution = await getPluginService().execute(c.req.param("id"), c.req.param("actionId"), userId(c), body.workspaceId || null, body.input || {});
    return c.json({ success: true, executionId: execution.executionId, data: execution.result });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/** @deprecated V1.5 compatibility shim. Prefer /:id/actions/:actionId/execute. */
pluginsRouter.post("/:name/execute", async (c) => {
  c.header("Deprecation", "true");
  c.header("Sunset", "2027-02-23");
  try {
    const name = c.req.param("name");
    const plugin = getPluginService().list(false).find((item) => item.id === name || item.name === name);
    if (!plugin) return c.json({ success: false, error: "插件不存在", code: "PLUGIN_NOT_FOUND" }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const requestedAction = typeof body.actionId === "string" ? body.actionId : undefined;
    const action = (plugin.actions as Array<{ id: string }>).find((item) => item.id === requestedAction) || (plugin.actions as Array<{ id: string }>)[0];
    if (!action) return c.json({ success: false, error: "插件没有可执行 Action" }, 400);
    const params = requestedAction ? (body.input || {}) : body;
    const execution = await getPluginService().execute(String(plugin.id), action.id, userId(c), null, params);
    return c.json({ ...execution.result, executionId: execution.executionId });
  } catch (error) { return errorResponse(c, error); }
});

export default pluginsRouter;
