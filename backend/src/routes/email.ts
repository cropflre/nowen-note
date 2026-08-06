/**
 * 邮件服务（SMTP）配置与测试 —— 管理员专属
 *
 * - GET  /api/email/smtp
 * - PUT  /api/email/smtp
 * - POST /api/email/smtp/test
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { requireAdmin } from "../middleware/acl.js";
import { verifySudoFromRequest } from "../lib/auth-security.js";
import { userSecurityRepository } from "../repositories";
import {
  readSmtpConfig,
  writeSmtpConfig,
  toPublicConfig,
  sendMail,
  type WriteSmtpInput,
} from "../services/email.js";

const emailRouter = new Hono();

// 全组管理员守卫：邮件服务涉及凭证 + 对外发信，不该让普通用户触达。
emailRouter.use("*", requireAdmin);

/** 写操作需 sudo，tokenVersion 通过统一 Repository 查询。 */
async function requireSudo(c: Context): Promise<Response | null> {
  const userId = c.req.header("X-User-Id") || "";
  const tokenVersion = await userSecurityRepository.getTokenVersionAsync(userId);
  const sudo = verifySudoFromRequest(c, userId, tokenVersion);
  if (!sudo.ok) {
    return c.json({ error: sudo.message, code: sudo.code }, sudo.status as 401 | 403);
  }
  return null;
}

emailRouter.get("/smtp", (c) => {
  const config = readSmtpConfig();
  return c.json(toPublicConfig(config));
});

emailRouter.put("/smtp", async (c) => {
  const denied = await requireSudo(c);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => ({}))) as Partial<WriteSmtpInput>;

  if (body.enabled) {
    if (!body.host || !String(body.host).trim()) {
      return c.json({ error: "启用 SMTP 时必须填写 host" }, 400);
    }
    if (!body.port || Number(body.port) <= 0 || Number(body.port) > 65535) {
      return c.json({ error: "port 必须在 1-65535 之间" }, 400);
    }
    const from = (body.fromEmail || body.username || "").toString().trim();
    if (!from || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
      return c.json({ error: "发件人邮箱格式不合法" }, 400);
    }
  }

  const saved = writeSmtpConfig({
    enabled: !!body.enabled,
    host: body.host || "",
    port: Number(body.port) || 465,
    secure: body.secure !== false,
    username: body.username || "",
    password: body.password,
    fromName: body.fromName || "",
    fromEmail: body.fromEmail || "",
  });

  return c.json(saved);
});

emailRouter.post("/smtp/test", async (c) => {
  const denied = await requireSudo(c);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => ({}))) as { to?: string };
  const to = (body.to || "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return c.json({ error: "收件人邮箱格式不合法" }, 400);
  }

  const result = await sendMail({
    to,
    subject: "[nowen-note] SMTP 测试邮件",
    text:
      "这是一封来自 nowen-note 的 SMTP 测试邮件。\n\n" +
      "如果你能看到这条消息，说明 SMTP 配置正常，可以用于后续的「备份文件发送到邮箱」等自动化场景。\n\n" +
      `发送时间：${new Date().toLocaleString()}`,
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 502);
  }
  return c.json({ success: true, lastResponse: result.lastResponse });
});

export default emailRouter;
