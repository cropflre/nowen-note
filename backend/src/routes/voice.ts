import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { readAttachmentObject } from "../services/attachment-storage";
import { getUserSpeechSettings, publicSpeechSettings, setUserSpeechSettings } from "../services/userSpeechSettings";
import { MAX_TRANSCRIPTION_BYTES, SpeechTranscriptionError, speechConnectionProbe, speechEndpoint, transcribeSpeech } from "../services/speechTranscription";

const voice = new Hono();
const language = z.string().regex(/^(auto|[a-z]{2,3})$/).nullable().optional();
const settingsSchema = z.object({ apiUrl: z.string().max(2048), apiKey: z.string().max(4096).optional(), model: z.string().trim().min(1).max(200), language });

voice.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "Unauthorized" }, 401);
  // 语音服务配置和调用仅向登录用户开放，避免通用 API Token 越过资源授权。
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ error: "语音功能需要用户登录" }, 403);
  await next();
});

voice.get("/settings", (c) => c.json(publicSpeechSettings(getUserSpeechSettings(c.req.header("X-User-Id")!))));
voice.put("/settings", async (c) => {
  const input = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "语音配置无效" }, 400);
  if (input.data.apiUrl) {
    try { speechEndpoint(input.data.apiUrl); } catch { return c.json({ error: "请输入有效的 HTTP/HTTPS 服务地址" }, 400); }
  }
  setUserSpeechSettings(c.req.header("X-User-Id")!, { ...input.data, language: input.data.language === "auto" ? null : input.data.language || null });
  return c.json(publicSpeechSettings(getUserSpeechSettings(c.req.header("X-User-Id")!)));
});

voice.post("/test", async (c) => {
  try {
    await transcribeSpeech(getUserSpeechSettings(c.req.header("X-User-Id")!), speechConnectionProbe(), "probe.wav", "audio/wav", "auto", c.req.raw.signal);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof SpeechTranscriptionError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "语音转写测试失败" }, 502);
  }
});

voice.post("/transcriptions", async (c) => {
  const input = z.object({ attachmentId: z.string().uuid(), language }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "转写请求无效" }, 400);
  const row = getDb().prepare("SELECT id, noteId, mimeType, size, path, filename FROM attachments WHERE id = ?").get(input.data.attachmentId) as { noteId: string; mimeType: string; size: number; path: string; filename: string } | undefined;
  if (!row) return c.json({ error: "附件不存在" }, 404);
  if (!hasPermission(resolveNotePermission(row.noteId, c.req.header("X-User-Id")!).permission, "read")) return c.json({ error: "无权读取此附件" }, 403);
  if (!row.mimeType.toLowerCase().startsWith("audio/")) return c.json({ error: "仅支持音频附件转写" }, 400);
  if (row.size > MAX_TRANSCRIPTION_BYTES) return c.json({ error: "音频超过转写限制（25 MB）" }, 413);
  try {
    const bytes = await readAttachmentObject(row.path);
    if (!bytes) return c.json({ error: "附件文件不存在" }, 404);
    return c.json(await transcribeSpeech(getUserSpeechSettings(c.req.header("X-User-Id")!), bytes, row.filename, row.mimeType, input.data.language, c.req.raw.signal));
  } catch (error) {
    if (error instanceof SpeechTranscriptionError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "读取或转写音频失败" }, 502);
  }
});

export default voice;
