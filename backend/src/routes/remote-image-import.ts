import { Hono } from "hono";
import {
  importRemoteImageForNote,
  RemoteImageError,
} from "../services/remote-image-import";
import {
  cancelLocalizationJob,
  createLocalizationJob,
  getLocalizationJob,
  listLocalizationJobs,
  LocalizationJobError,
  retryLocalizationJob,
  scanLocalizationScope,
  type LocalizationScopeInput,
} from "../services/remote-image-localization";
import wechatFavoritesImportRouter from "./wechat-favorites-import";

const router = new Hono();

async function readJsonBody(c: Parameters<typeof router.post>[1] extends (context: infer C) => unknown ? C : never) {
  try {
    return await c.req.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function localizationErrorResponse(c: any, error: unknown) {
  if (error instanceof LocalizationJobError || error instanceof RemoteImageError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  console.error("[remote-image-localization] request failed:", error);
  return c.json({
    error: error instanceof Error ? error.message : "网络图片本地化失败",
    code: "REMOTE_IMAGE_LOCALIZATION_FAILED",
  }, 500);
}

router.post("/import-remote-image", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);

  const noteId = typeof body.noteId === "string" ? body.noteId.trim() : "";
  const remoteUrl = typeof body.url === "string" ? body.url.trim() : "";
  const uploadSource = typeof body.source === "string"
    ? body.source.trim().slice(0, 64) || "remote-image"
    : "remote-image";
  if (!noteId || !remoteUrl) {
    return c.json({ error: "noteId 和 url 必传", code: "INVALID_BODY" }, 400);
  }

  try {
    const result = await importRemoteImageForNote({
      noteId,
      userId,
      url: remoteUrl,
      uploadSource,
    });
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof RemoteImageError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    return c.json({
      error: `写入附件失败：${error instanceof Error ? error.message : String(error)}`,
      code: "REMOTE_IMAGE_SAVE_FAILED",
    }, 500);
  }
});

/**
 * 扫描历史笔记中的图片引用，不下载、不修改正文。
 *
 * Body（二选一）：
 *   { noteIds: ["..."], expectedVersions?: { [noteId]: version } }
 *   { notebookId: "...", expectedVersions?: { [noteId]: version } }
 */
router.post("/remote-image-localization/scan", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
  try {
    return c.json(scanLocalizationScope(userId, body as LocalizationScopeInput));
  } catch (error) {
    return localizationErrorResponse(c, error);
  }
});

/** 创建后台任务。页面关闭或移动端切后台不会中断服务端任务。 */
router.post("/remote-image-localization/jobs", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "请求格式错误", code: "INVALID_BODY" }, 400);
  try {
    return c.json(createLocalizationJob(userId, body as LocalizationScopeInput), 202);
  } catch (error) {
    return localizationErrorResponse(c, error);
  }
});

router.get("/remote-image-localization/jobs", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const limit = Number.parseInt(c.req.query("limit") || "20", 10);
  return c.json({ jobs: listLocalizationJobs(userId, limit) });
});

router.get("/remote-image-localization/jobs/:id", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  try {
    return c.json(getLocalizationJob(userId, c.req.param("id")));
  } catch (error) {
    return localizationErrorResponse(c, error);
  }
});

router.post("/remote-image-localization/jobs/:id/cancel", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  try {
    return c.json(cancelLocalizationJob(userId, c.req.param("id")));
  } catch (error) {
    return localizationErrorResponse(c, error);
  }
});

router.post("/remote-image-localization/jobs/:id/retry", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  try {
    return c.json(retryLocalizationJob(userId, c.req.param("id")), 202);
  } catch (error) {
    return localizationErrorResponse(c, error);
  }
});

router.route("/", wechatFavoritesImportRouter);

export default router;
