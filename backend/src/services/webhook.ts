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

import { webhookRepository } from "../repositories/webhookRepository";
import crypto from "crypto";

// ===== 类型定义 =====

export type WebhookEvent =
  | "note.created" | "note.updated" | "note.deleted" | "note.trashed" | "note.trash_emptied"
  | "notebook.created" | "notebook.deleted"
  | "tag.created"
  | "task.created" | "task.completed"
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
  webhookRepository.initTables();
}

// ===== HMAC 签名 =====

function signPayload(payload: string, secret: string): string {
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
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
      const webhooks = webhookRepository.listActiveByUser<WebhookConfig>(userId);

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
    const deliveryId = crypto.randomUUID();

    const payload = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data,
    });

    const signature = signPayload(payload, webhook.secret);

    let lastStatus: number | null = null;
    let lastBody = "";
    let success = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10秒超时

        const res = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Nowen-Event": event,
            "X-Nowen-Signature": signature ? `sha256=${signature}` : "",
            "X-Nowen-Delivery": deliveryId,
            "User-Agent": "Nowen-Note-Webhook/1.0",
          },
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        lastStatus = res.status;
        lastBody = await res.text().catch(() => "");

        if (res.ok) {
          success = true;
          break;
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
      webhookRepository.recordDelivery({
        id: deliveryId,
        webhookId: webhook.id,
        event,
        payload,
        responseStatus: lastStatus,
        responseBody: (lastBody || "").slice(0, 2000),
        success: success ? 1 : 0,
        attempts: maxRetries,
      });
    } catch { /* 日志写入失败不影响主流程 */ }
  }
}

// ===== 导出 =====

export const webhookDispatcher = WebhookDispatcher.getInstance();

/** 便捷方法：触发事件 */
export function emitWebhook(event: WebhookEvent, userId: string, data: Record<string, any>): void {
  webhookDispatcher.emit(event, userId, data);
}
