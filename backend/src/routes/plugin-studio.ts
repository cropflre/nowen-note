import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isSystemAdmin } from "../middleware/acl.js";
import { getExtensionPlatformFeatureFlags } from "../plugins/featureFlags.js";
import { getPluginStudioProjectService } from "../plugins/studio/projectService.js";
import type { PluginStudioActor, PluginStudioProjectStatus } from "../plugins/studio/types.js";

const pluginStudioRouter = new Hono();

function actor(c: any): PluginStudioActor {
  const userId = c.req.header("X-User-Id") || "";
  return { userId, isAdmin: isSystemAdmin(userId) };
}

function errorResponse(c: any, error: unknown) {
  const coded = error as Error & { code?: string };
  const status = coded.code === "PLUGIN_STUDIO_AUTH_REQUIRED" ? 401
    : coded.code === "PLUGIN_STUDIO_FORBIDDEN" ? 403
      : coded.code === "PLUGIN_STUDIO_PROJECT_NOT_FOUND" || coded.code === "PLUGIN_STUDIO_FILE_NOT_FOUND" ? 404
        : coded.code === "PLUGIN_STUDIO_REVISION_CONFLICT" ? 409
          : coded.code === "PLUGIN_STUDIO_FILE_TOO_LARGE"
            || coded.code === "PLUGIN_STUDIO_FILE_LIMIT_EXCEEDED"
            || coded.code === "PLUGIN_STUDIO_PROJECT_TOO_LARGE"
            || coded.code === "PLUGIN_STUDIO_IMPORT_TOO_LARGE" ? 413
            : 400;
  return c.json({
    success: false,
    error: coded.message || String(error),
    code: coded.code || "PLUGIN_STUDIO_ERROR",
  }, status as any);
}

pluginStudioRouter.use("*", async (c, next) => {
  if (!getExtensionPlatformFeatureFlags().pluginStudio) {
    return c.json({
      success: false,
      error: "AI Plugin Studio 当前未启用",
      code: "PLUGIN_STUDIO_FEATURE_DISABLED",
    }, 404);
  }
  await next();
});

pluginStudioRouter.get("/projects", (c) => {
  try {
    return c.json(getPluginStudioProjectService().listProjects(actor(c)));
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.post("/projects", async (c) => {
  try {
    const body = await c.req.json() as { name?: string };
    const project = getPluginStudioProjectService().createProject(actor(c), {
      name: String(body.name || ""),
    });
    return c.json({ success: true, project }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.post("/projects/import", bodyLimit({
  maxSize: 13 * 1024 * 1024,
  onError: (c) => c.json({
    success: false,
    error: "Studio 项目导入请求不能超过 13 MiB",
    code: "PLUGIN_STUDIO_IMPORT_TOO_LARGE",
  }, 413),
}), async (c) => {
  try {
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!(upload instanceof File)) {
      return c.json({ success: false, error: "请上传 file 字段中的 ZIP 文件", code: "PLUGIN_STUDIO_IMPORT_INVALID" }, 400);
    }
    const fallbackName = upload.name.replace(/\.(?:zip|nowen-studio)$/i, "") || "Imported Plugin";
    const project = await getPluginStudioProjectService().importProject(actor(c), {
      name: String(body.name || fallbackName),
      archive: Buffer.from(await upload.arrayBuffer()),
    });
    return c.json({ success: true, project }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.get("/projects/:id", (c) => {
  try {
    return c.json(getPluginStudioProjectService().getProject(actor(c), c.req.param("id")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.patch("/projects/:id", async (c) => {
  try {
    const body = await c.req.json() as {
      name?: string;
      status?: PluginStudioProjectStatus;
      expectedRevision?: number;
    };
    const project = getPluginStudioProjectService().updateProject(actor(c), c.req.param("id"), {
      name: body.name,
      status: body.status,
      expectedRevision: Number(body.expectedRevision),
    });
    return c.json({ success: true, project });
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.get("/projects/:id/export", async (c) => {
  try {
    const { project, archive } = await getPluginStudioProjectService().exportProject(actor(c), c.req.param("id"));
    return new Response(new Uint8Array(archive), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${project.slug}.nowen-studio.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.get("/projects/:id/files", (c) => {
  try {
    return c.json(getPluginStudioProjectService().listFiles(actor(c), c.req.param("id")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.get("/projects/:id/files/content", (c) => {
  try {
    return c.json(getPluginStudioProjectService().readFile(
      actor(c),
      c.req.param("id"),
      c.req.query("path") || "",
    ));
  } catch (error) {
    return errorResponse(c, error);
  }
});

pluginStudioRouter.put("/projects/:id/files/content", bodyLimit({
  maxSize: 3 * 1024 * 1024,
  onError: (c) => c.json({
    success: false,
    error: "Studio 文件写入请求不能超过 3 MiB",
    code: "PLUGIN_STUDIO_FILE_TOO_LARGE",
  }, 413),
}), async (c) => {
  try {
    const body = await c.req.json() as {
      path?: string;
      content?: string;
      encoding?: "utf8" | "base64";
      expectedRevision?: number;
    };
    return c.json({
      success: true,
      ...getPluginStudioProjectService().writeFile(actor(c), c.req.param("id"), {
        path: String(body.path || ""),
        content: typeof body.content === "string" ? body.content : "",
        encoding: body.encoding,
        expectedRevision: Number(body.expectedRevision),
      }),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default pluginStudioRouter;
