import { getDb } from "../db/schema";

export interface WebhookDeliveryInput {
  id: string;
  webhookId: string;
  event: string;
  payload: string;
  responseStatus: number | null;
  responseBody: string;
  success: number;
  attempts: number;
}

export const webhookRepository = {
  initTables(): void {
    getDb().exec(`
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
  },

  listActiveByUser<T>(userId: string): T[] {
    return getDb()
      .prepare("SELECT * FROM webhooks WHERE userId = ? AND isActive = 1")
      .all(userId) as T[];
  },

  recordDelivery(input: WebhookDeliveryInput): void {
    getDb()
      .prepare(`
        INSERT INTO webhook_deliveries (
          id, webhookId, event, payload, responseStatus, responseBody, success, attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.webhookId,
        input.event,
        input.payload,
        input.responseStatus,
        input.responseBody,
        input.success,
        input.attempts,
      );
  },
};
