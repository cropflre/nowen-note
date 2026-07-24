/**
 * SMTP 邮件发送服务（零三方依赖）
 *
 * 为什么不引入 nodemailer？
 *   - 本项目本地优先 + 可离线部署，依赖越少越好；
 *   - 我们的用法极度克制：只发"管理员发起的备份邮件 + 测试邮件"，不需要池化、
 *     队列、模板引擎这些 nodemailer 的重型能力；
 *   - 走 Node 内建 net/tls 手写 ESMTP 对话，不到 300 行，行为可控，
 *     出错也能在日志里直接看到 SMTP 原始响应码，排障比黑盒 lib 清晰。
 *
 * 安全：
 *   - SMTP 密码经 AES-256-GCM 加密后才写入 system_settings（`smtp:config`），
 *     密钥派生自 JWT_SECRET + 固定盐；JWT_SECRET 丢失 / 更换则旧密码无法解密，
 *     需要管理员重新填一遍，这比明文落库好得多；
 *   - GET 接口永远不回明文密码，只返回 `hasPassword: boolean`；
 *   - 邮件附件大小上限默认 25 MB（多数邮箱服务商 attach 上限），再大会被
 *     大部分服务商拒收且会撑爆内存，路由层会更早拦截。
 */

import net from "net";
import tls from "tls";
import crypto from "crypto";
import { systemSettingsRepository } from "../repositories/systemSettingsRepository";

// ============================================================================
// 类型
// ============================================================================

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean; // true = 465 纯 TLS；false = 587/25 明文或 STARTTLS
  username: string;
  /** 仅写入时出现；读取时永远不暴露明文，改返回 hasPassword */
  password?: string;
  fromName: string;
  fromEmail: string;
}

export interface SmtpConfigPublic {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromName: string;
  fromEmail: string;
  hasPassword: boolean;
  updatedAt: string | null;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
}

export interface SendMailResult {
  success: boolean;
  /** SMTP 末次响应（250 OK / 550 ... 之类），便于前端直接 toast */
  lastResponse?: string;
  error?: string;
}

// ============================================================================
// 配置持久化 —— system_settings['smtp:config']
// ============================================================================

const SETTING_KEY = "smtp:config";
/** 25 MB；大部分邮件服务商硬上限；超过会在路由层直接 413。 */
export const EMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

function deriveCipherKey(): Buffer {
  // 不直接用 JWT_SECRET 原值，避免"解密邮件密码 === 伪造 JWT"的攻击面耦合；
  // 加固定盐 + scryptSync 派生 32 字节密钥。
  const secret = process.env.JWT_SECRET || "nowen-note-default-secret";
  return crypto.scryptSync(secret, "nowen-smtp-v1", 32);
}

function encryptPassword(plain: string): string {
  if (!plain) return "";
  const key = deriveCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptPassword(encoded: string): string {
  if (!encoded) return "";
  if (!encoded.startsWith("v1:")) return ""; // 兼容：非预期格式当空密码处理，避免抛错
  try {
    const [, ivB64, tagB64, dataB64] = encoded.split(":");
    const key = deriveCipherKey();
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch (e) {
    console.warn("[email] decrypt smtp password failed:", e);
    return "";
  }
}

/**
 * 读出完整配置（含明文密码，仅服务器内部使用！）。
 * 公开 API 必须用 toPublic() 剥掉密码字段。
 */
export function readSmtpConfig(): SmtpConfig & { updatedAt: string | null } {
  const row = systemSettingsRepository.get(SETTING_KEY);

  const fallback: SmtpConfig & { updatedAt: string | null } = {
    enabled: false,
    host: "",
    port: 465,
    secure: true,
    username: "",
    password: "",
    fromName: "",
    fromEmail: "",
    updatedAt: null,
  };

  if (!row) return fallback;
  try {
    const parsed = JSON.parse(row.value) as Partial<SmtpConfig> & { passwordEnc?: string };
    return {
      enabled: !!parsed.enabled,
      host: parsed.host || "",
      port: typeof parsed.port === "number" ? parsed.port : 465,
      secure: parsed.secure !== false,
      username: parsed.username || "",
      password: decryptPassword(parsed.passwordEnc || ""),
      fromName: parsed.fromName || "",
      fromEmail: parsed.fromEmail || "",
      updatedAt: row.updatedAt,
    };
  } catch {
    return fallback;
  }
}

export function toPublicConfig(cfg: SmtpConfig & { updatedAt: string | null }): SmtpConfigPublic {
  return {
    enabled: cfg.enabled,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.username,
    fromName: cfg.fromName,
    fromEmail: cfg.fromEmail,
    hasPassword: !!cfg.password,
    updatedAt: cfg.updatedAt,
  };
}

export interface WriteSmtpInput {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** undefined 表示"不动旧密码"；空字符串表示"清空密码"；非空字符串覆盖 */
  password?: string;
  fromName: string;
  fromEmail: string;
}

export function writeSmtpConfig(input: WriteSmtpInput): SmtpConfigPublic {
  const current = readSmtpConfig();

  // 密码处理：undefined → 复用旧的；其它值 → 按新值加密（即便是空字符串，代表清空）
  const newPlain = input.password === undefined ? current.password || "" : input.password;
  const passwordEnc = newPlain ? encryptPassword(newPlain) : "";

  const value = JSON.stringify({
    enabled: !!input.enabled,
    host: (input.host || "").trim(),
    port: Number(input.port) || 465,
    secure: !!input.secure,
    username: (input.username || "").trim(),
    passwordEnc,
    fromName: (input.fromName || "").trim(),
    fromEmail: (input.fromEmail || "").trim(),
  });

  systemSettingsRepository.set(SETTING_KEY, value);

  return toPublicConfig(readSmtpConfig());
}

// ============================================================================
// SMTP 客户端（手写 ESMTP 对话）
// ============================================================================

/**
 * 和 SMTP 服务器做一轮命令-响应交互，返回"最后一行响应字符串"。
 *
 * ESMTP 响应格式：
 *   250-smtp.example.com Hello
 *   250-SIZE 52428800
 *   250 AUTH LOGIN PLAIN
 * 中间行以 `<code>-` 开头（表示后面还有续行），末行以 `<code><space>` 开头。
 * 我们的解析只需要知道"末行在哪结束 + 末行 code"即可，不关心中间续行内容。
 */
function smtpCommand(
  socket: net.Socket | tls.TLSSocket,
  command: string | null,
  timeoutMs: number,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // 行末检测：SMTP 多行响应的结束是 `^\d{3}\s` 开头的那一行
      const lines = buffer.split(/\r?\n/);
      // 最后一行如果是空（刚好 \r\n 结尾），取倒数第二行作为"末行"
      const last = lines[lines.length - 1] === "" ? lines[lines.length - 2] : lines[lines.length - 1];
      if (last && /^\d{3}\s/.test(last)) {
        cleanup();
        const code = parseInt(last.slice(0, 3), 10);
        resolve({ code, text: buffer.trim() });
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`SMTP 命令超时: ${command || "<greeting>"}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onErr);
    }

    socket.on("data", onData);
    socket.on("error", onErr);
    if (command !== null) {
      socket.write(command + "\r\n");
    }
  });
}

function assertCode(resp: { code: number; text: string }, expect: number[], step: string): void {
  if (!expect.includes(resp.code)) {
    throw new Error(`SMTP ${step} 失败：${resp.text.split(/\r?\n/).slice(-1)[0] || `code=${resp.code}`}`);
  }
}

/** 构造 MIME 邮件体（multipart/mixed + 附件 base64） */
function buildMimeMessage(cfg: SmtpConfig, opt: SendMailOptions): string {
  const boundary = `=_nowen_${crypto.randomBytes(12).toString("hex")}`;
  const fromHeader = cfg.fromName
    ? `${encodeMimeWord(cfg.fromName)} <${cfg.fromEmail || cfg.username}>`
    : cfg.fromEmail || cfg.username;
  const date = new Date().toUTCString();
  const messageId = `<${crypto.randomUUID()}@nowen-note>`;

  const headers: string[] = [
    `From: ${fromHeader}`,
    `To: ${opt.to}`,
    `Subject: ${encodeMimeWord(opt.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
  ];

  const hasAttach = opt.attachments && opt.attachments.length > 0;
  const text = opt.text || "";
  const html = opt.html || "";

  if (!hasAttach) {
    // 简单文本或 html
    if (html) {
      headers.push("Content-Type: text/html; charset=UTF-8");
      headers.push("Content-Transfer-Encoding: base64");
      return headers.join("\r\n") + "\r\n\r\n" + chunkBase64(Buffer.from(html, "utf8").toString("base64"));
    }
    headers.push("Content-Type: text/plain; charset=UTF-8");
    headers.push("Content-Transfer-Encoding: base64");
    return headers.join("\r\n") + "\r\n\r\n" + chunkBase64(Buffer.from(text, "utf8").toString("base64"));
  }

  // multipart/mixed
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  parts.push(`--${boundary}`);
  if (html) {
    parts.push("Content-Type: text/html; charset=UTF-8");
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    parts.push(chunkBase64(Buffer.from(html, "utf8").toString("base64")));
  } else {
    parts.push("Content-Type: text/plain; charset=UTF-8");
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    parts.push(chunkBase64(Buffer.from(text || " ", "utf8").toString("base64")));
  }
  for (const att of opt.attachments!) {
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.contentType || "application/octet-stream"}; name="${encodeMimeWord(att.filename)}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${encodeMimeWord(att.filename)}"`);
    parts.push("");
    parts.push(chunkBase64(att.content.toString("base64")));
  }
  parts.push(`--${boundary}--`);

  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
}

/** RFC 2047 Q/B encoded-word，用于含中文的 Subject / filename */
function encodeMimeWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** base64 切成 76 列，符合 RFC 2045 */
function chunkBase64(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/**
 * 发邮件主入口。
 *
 * 流程：
 *   1. 读 SMTP 配置（未启用 / 未填完整 → 直接 err 返回）
 *   2. 建 socket（secure=true 用 tls.connect，false 用 net.connect）
 *   3. 读欢迎 220 → EHLO → （若 !secure 且服务器公布 STARTTLS → 升级 TLS → 再 EHLO 一次）
 *   4. AUTH LOGIN（base64 user / pass）
 *   5. MAIL FROM → RCPT TO → DATA → <MIME 正文> → .
 *   6. QUIT
 *
 * 任一步失败都会 resolve(SendMailResult{ success:false, error })，调用方据此 toast。
 */
export async function sendMail(opt: SendMailOptions): Promise<SendMailResult> {
  const cfgFull = readSmtpConfig();

  if (!cfgFull.enabled) return { success: false, error: "邮件服务未启用（SMTP disabled）" };
  if (!cfgFull.host) return { success: false, error: "SMTP 配置不完整：host 为空" };
  if (!cfgFull.username) return { success: false, error: "SMTP 配置不完整：username 为空" };
  if (!cfgFull.password) return { success: false, error: "SMTP 配置不完整：password 为空" };
  if (!cfgFull.fromEmail && !cfgFull.username) return { success: false, error: "SMTP 配置不完整：from 为空" };

  const from = cfgFull.fromEmail || cfgFull.username;
  const timeoutMs = 15000;

  let socket: net.Socket | tls.TLSSocket;
  try {
    socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      if (cfgFull.secure) {
        const s = tls.connect({ host: cfgFull.host, port: cfgFull.port, servername: cfgFull.host });
        s.once("secureConnect", () => resolve(s));
        s.once("error", onErr);
      } else {
        const s = net.connect({ host: cfgFull.host, port: cfgFull.port });
        s.once("connect", () => resolve(s));
        s.once("error", onErr);
      }
      setTimeout(() => reject(new Error("SMTP 连接超时")), timeoutMs);
    });
  } catch (e) {
    return { success: false, error: `无法连接 SMTP：${(e as Error).message}` };
  }

  try {
    // 1) 欢迎
    assertCode(await smtpCommand(socket, null, timeoutMs), [220], "greeting");

    // 2) EHLO
    const hostname = "nowen-note.local";
    let ehlo = await smtpCommand(socket, `EHLO ${hostname}`, timeoutMs);
    assertCode(ehlo, [250], "EHLO");

    // 3) 非纯 TLS 且对端公布 STARTTLS，则升级
    if (!cfgFull.secure && /\bSTARTTLS\b/i.test(ehlo.text)) {
      assertCode(await smtpCommand(socket, "STARTTLS", timeoutMs), [220], "STARTTLS");
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect({ socket: socket as net.Socket, servername: cfgFull.host });
        s.once("secureConnect", () => resolve(s));
        s.once("error", reject);
      });
      // 升级后必须重 EHLO
      ehlo = await smtpCommand(socket, `EHLO ${hostname}`, timeoutMs);
      assertCode(ehlo, [250], "EHLO after STARTTLS");
    }

    // 4) AUTH LOGIN
    assertCode(await smtpCommand(socket, "AUTH LOGIN", timeoutMs), [334], "AUTH LOGIN init");
    assertCode(
      await smtpCommand(socket, Buffer.from(cfgFull.username, "utf8").toString("base64"), timeoutMs),
      [334],
      "AUTH LOGIN user",
    );
    assertCode(
      await smtpCommand(socket, Buffer.from(cfgFull.password, "utf8").toString("base64"), timeoutMs),
      [235],
      "AUTH LOGIN pass",
    );

    // 5) MAIL FROM / RCPT TO
    assertCode(await smtpCommand(socket, `MAIL FROM:<${from}>`, timeoutMs), [250], "MAIL FROM");
    assertCode(await smtpCommand(socket, `RCPT TO:<${opt.to}>`, timeoutMs), [250, 251], "RCPT TO");

    // 6) DATA → body → .
    assertCode(await smtpCommand(socket, "DATA", timeoutMs), [354], "DATA");
    const mime = buildMimeMessage(
      { ...cfgFull, password: "" /* 不让密码进 MIME 构造器的任何分支 */ },
      opt,
    );
    // RFC 5321: body 中独占一行的 "." 要被 dot-stuffing 成 ".."
    const dotStuffed = mime.split(/\r?\n/).map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
    const finalResp = await smtpCommand(socket, dotStuffed + "\r\n.", timeoutMs * 2);
    assertCode(finalResp, [250], "DATA end");

    // 7) QUIT（即使失败也不报错）
    try {
      await smtpCommand(socket, "QUIT", 5000);
    } catch {
      /* ignore */
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }

    return { success: true, lastResponse: finalResp.text.split(/\r?\n/).slice(-1)[0] };
  } catch (e) {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    return { success: false, error: (e as Error).message };
  }
}
