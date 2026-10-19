import { secureExternalFetch } from "../plugins/secureExternalFetch.js";
import { formatPushPlusTaskEvent, isPushPlusJsonWebhook, isPushPlusAccepted } from "./pushPlusDigest.js";
/**
 * Nowen Note Webhook 事件系统
 *
 * 支持注册 Webhook URL，当指定事件发生时自动推送通知。
 * 事件类型：
 *  - note.created / note.updated / note.deleted / note.trashed
 *  - notebook.created / notebook.deleted
 *  - tag.created
 *  - task.created / task.completed
 *  - plugin.executed
 *
 * 特性：
 *  - 异步推送（不阻塞主流程）
 *  - 自动重试（最多3次，指数退避）
 *  - Secret 签名验证（HMAC-SHA256）
 *  - 投递日志记录
 */

import { getDb } from "../db/schema.js";
import crypto from "crypto";

// ===== 类型定义 =====

export type WebhookEvent =
  | "note.created" | "note.updated" | "note.deleted" | "note.trashed" | "note.trash_emptied"
  | "notebook.created" | "notebook.deleted"
  | "tag.created"
  | "task.created" | "task.completed" | "task.digest.morning" | "task.digest.evening" | "task.due"
  | "plugin.executed"
  | "*";  // 通配：接收所有事件

export interface WebhookConfig {
  id: string;
  userId: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  isActive: number;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  responseStatus: number | null;
  responseBody: string;
  success: number;
  attempts: number;
  deliveredAt: string;
}

// ===== 数据库迁移 =====

export function initWebhookTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      events TEXT NOT NULL DEFAULT '["*"]',
      isActive INTEGER DEFAULT 1,
      description TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhookId TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      responseStatus INTEGER,
      responseBody TEXT DEFAULT '',
      success INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      deliveredAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (webhookId) REFERENCES webhooks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(userId);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhookId);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_time ON webhook_deliveries(deliveredAt DESC);
  `);
}

// ===== HMAC 签名 =====

function signPayload(payload: string, secret: string): string {
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function webhookTimestamp(event: WebhookEvent, timezone: unknown): string {
  const now = new Date();
  const utc = now.toISOString();
  if (!(event === "task.digest.morning" || event === "task.digest.evening" || event === "task.due")
    || typeof timezone !== "string" || !timezone) return utc;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      timeZoneName: "longOffset",
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)!.value;
    const offset = value("timeZoneName").replace("GMT", "") || "+00:00";
    // Preserve the instant and milliseconds; include the offset for webhook consumers.
    return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}${utc.slice(19, 23)}${offset}`;
  } catch {
    // Legacy/custom events may not carry a valid timezone. Keep them deliverable.
    return utc;
  }
}

// ===== 事件分发器 =====

class WebhookDispatcher {
  private static instance: WebhookDispatcher;

  static getInstance(): WebhookDispatcher {
    if (!this.instance) {
      this.instance = new WebhookDispatcher();
    }
    return this.instance;
  }

  /** 触发事件 — 异步推送所有匹配的 Webhook */
  async emit(event: WebhookEvent, userId: string, data: Record<string, any>): Promise<void> {
    try {
      const db = getDb();
      const webhooks = db.prepare(
        "SELECT * FROM webhooks WHERE userId = ? AND isActive = 1"
      ).all(userId) as WebhookConfig[];

      for (const webhook of webhooks) {
        const events: string[] = JSON.parse(webhook.events as any);
        if (events.includes("*") || events.includes(event)) {
          // 异步投递，不阻塞
          this.deliver(webhook, event, data).catch(err => {
            console.error(`[Webhook] 投递失败 ${webhook.id}:`, err.message);
          });
        }
      }
    } catch (err: any) {
      console.error("[Webhook] 事件分发错误:", err.message);
    }
  }

  /** 投递单个 Webhook（含重试） */
  private async deliver(
    webhook: WebhookConfig,
    event: WebhookEvent,
    data: Record<string, any>,
    maxRetries: number = 3,
  ): Promise<void> {
    const db = getDb();
    const deliveryId = crypto.randomUUID();

    const timestamp = webhookTimestamp(event, data.timezone);
    // PushPlus webhook-only JSON accepts the entire POST body as message content.
    // Only rewrite task digest events for the verified provider endpoint.
    const pushPlusJson = isPushPlusJsonWebhook(webhook.url)
      && (event === "task.digest.morning" || event === "task.digest.evening" || event === "task.due");
    const payload = JSON.stringify(pushPlusJson
      ? formatPushPlusTaskEvent(event as "task.digest.morning" | "task.digest.evening" | "task.due", timestamp, data)
      : { event, timestamp, data });

    const signature = signPayload(payload, webhook.secret);

    let lastStatus: number | null = null;
    let lastBody = "";
    let success = false;
    let attemptCount = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attemptCount = attempt;
      try {
        // 重用 Host 的 DNS pinning 与公网目标校验，拒绝 SSRF、内网和跳转。
        const target = new URL(webhook.url);
        const res = await secureExternalFetch({
          url: webhook.url,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Nowen-Event": event,
            "X-Nowen-Signature": signature ? `sha256=${signature}` : "",
            "X-Nowen-Delivery": deliveryId,
            "User-Agent": "Nowen-Note-Webhook/1.0",
          },
          body: payload,
        }, {
          allowedHosts: [target.host],
          timeoutMs: 10000,
          maxRedirects: 0,
          maxResponseBytes: 2048,
        });
        lastStatus = res.status;
        lastBody = res.body;

        if (res.ok && (!pushPlusJson || isPushPlusAccepted(res.body))) {
          success = true;
          break;
        }
        if (res.ok && pushPlusJson) {
          // PushPlus can return HTTP 200 while rejecting the message. Do not
          // mark a failed provider response as a successful delivery.
          lastBody = "PushPlus API rejected the message";
        }
      } catch (err: any) {
        lastBody = err.message;
      }

      // 指数退避
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }

    // 记录投递日志
    try {
      db.prepare(`
        INSERT INTO webhook_deliveries (id, webhookId, event, payload, responseStatus, responseBody, success, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deliveryId,
        webhook.id,
        event,
        payload,
        lastStatus,
        (lastBody || "").slice(0, 2000), // 限制日志大小
        success ? 1 : 0,
        success ? attemptCount : maxRetries,
      );
    } catch { /* 日志写入失败不影响主流程 */ }
  }
}

// ===== 导出 =====

export const webhookDispatcher = WebhookDispatcher.getInstance();

/** 便捷方法：触发事件 */
export function emitWebhook(event: WebhookEvent, userId: string, data: Record<string, any>): void {
  webhookDispatcher.emit(event, userId, data);
}
