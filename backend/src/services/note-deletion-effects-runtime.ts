import crypto from "crypto";

import type { DatabaseAdapter } from "../db/adapters/types";

export interface SingleNoteDeletionCommittedEvent {
  kind: "note.deleted";
  actorUserId: string;
  noteOwnerUserId: string;
  workspaceId: string | null;
  noteId: string;
  attachmentCount: number;
  removedFiles: number;
  skippedSharedPaths: number;
  cleanupWarnings: string[];
}

export interface TrashEmptiedCommittedEvent {
  kind: "note.trash_emptied";
  actorUserId: string;
  ownerUserId: string;
  workspaceId: string | null;
  noteIds: string[];
  skipped: number;
  attachmentCount: number;
  removedFiles: number;
  skippedSharedPaths: number;
  cleanupWarnings: string[];
  freedBytesEstimate: number;
}

export type NoteDeletionCommittedEvent =
  | SingleNoteDeletionCommittedEvent
  | TrashEmptiedCommittedEvent;

interface WebhookConfigRow {
  id: string;
  url: string;
  secret: string;
  events: string | string[];
}

export interface NoteDeletionEffectsRuntimeOptions {
  recordAudit?: (event: NoteDeletionCommittedEvent) => Promise<void>;
  dispatchWebhook?: (event: NoteDeletionCommittedEvent) => Promise<void>;
  publishRealtime?: (event: NoteDeletionCommittedEvent) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  webhookMaxRetries?: number;
  webhookRetryBaseMs?: number;
  webhookTimeoutMs?: number;
}

export interface NoteDeletionEffectsRuntime {
  dispatch(event: NoteDeletionCommittedEvent): Promise<string[]>;
  shutdown(): Promise<void>;
}

function eventData(event: NoteDeletionCommittedEvent): Record<string, unknown> {
  if (event.kind === "note.deleted") {
    return {
      noteId: event.noteId,
      workspaceId: event.workspaceId,
      attachmentCount: event.attachmentCount,
      removedFiles: event.removedFiles,
      skippedSharedPaths: event.skippedSharedPaths,
      cleanupWarningCount: event.cleanupWarnings.length,
    };
  }

  return {
    count: event.noteIds.length,
    skipped: event.skipped,
    workspaceId: event.workspaceId,
    noteIdSample: event.noteIds.slice(0, 100),
    noteIdsTruncated: event.noteIds.length > 100,
    attachmentCount: event.attachmentCount,
    removedFiles: event.removedFiles,
    skippedSharedPaths: event.skippedSharedPaths,
    cleanupWarningCount: event.cleanupWarnings.length,
    freedBytesEstimate: event.freedBytesEstimate,
    vacuumed: false,
  };
}

function parseWebhookEvents(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function signPayload(payload: string, secret: string): string {
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createNoteDeletionEffectsRuntime(
  adapter: DatabaseAdapter,
  options: NoteDeletionEffectsRuntimeOptions = {},
): NoteDeletionEffectsRuntime {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = Math.max(1, options.webhookMaxRetries ?? 3);
  const retryBaseMs = Math.max(0, options.webhookRetryBaseMs ?? 1_000);
  const timeoutMs = Math.max(1, options.webhookTimeoutMs ?? 10_000);
  const pendingDeliveries = new Set<Promise<void>>();

  async function defaultRecordAudit(event: NoteDeletionCommittedEvent): Promise<void> {
    const details = JSON.stringify(eventData(event)).slice(0, 5_000);
    const action = event.kind === "note.deleted" ? "delete" : "trash_empty";
    const targetType = event.kind === "note.deleted" ? "note" : "trash";
    const targetId = event.kind === "note.deleted"
      ? event.noteId
      : (event.workspaceId || event.actorUserId);

    await adapter.execute(
      `INSERT INTO audit_logs (
         id, "userId", category, action, level, "targetType", "targetId",
         details, ip, "userAgent"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        event.actorUserId,
        "note",
        action,
        "info",
        targetType,
        targetId,
        details,
        "",
        "postgres-runtime",
      ],
    );
  }

  async function recordDelivery(params: {
    id: string;
    webhookId: string;
    event: string;
    payload: string;
    responseStatus: number | null;
    responseBody: string;
    success: boolean;
    attempts: number;
  }): Promise<void> {
    try {
      await adapter.execute(
        `INSERT INTO webhook_deliveries (
           id, "webhookId", event, payload, "responseStatus", "responseBody", success, attempts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.id,
          params.webhookId,
          params.event,
          params.payload,
          params.responseStatus,
          params.responseBody.slice(0, 2_000),
          params.success,
          params.attempts,
        ],
      );
    } catch (error) {
      console.warn("[note-deletion-effects-runtime] record webhook delivery failed:", errorMessage(error));
    }
  }

  async function deliverWebhook(
    webhook: WebhookConfigRow,
    event: NoteDeletionCommittedEvent,
  ): Promise<void> {
    const deliveryId = crypto.randomUUID();
    const payload = JSON.stringify({
      event: event.kind,
      timestamp: new Date().toISOString(),
      data: eventData(event),
    });
    const signature = signPayload(payload, webhook.secret);
    let responseStatus: number | null = null;
    let responseBody = "";
    let success = false;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts = attempt;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Nowen-Event": event.kind,
            "X-Nowen-Signature": signature ? `sha256=${signature}` : "",
            "X-Nowen-Delivery": deliveryId,
            "User-Agent": "Nowen-Note-Webhook/1.0",
          },
          body: payload,
          signal: controller.signal,
        });
        responseStatus = response.status;
        responseBody = await response.text().catch(() => "");
        if (response.ok) {
          success = true;
          break;
        }
      } catch (error) {
        responseBody = errorMessage(error);
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < maxRetries && retryBaseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryBaseMs * (2 ** (attempt - 1))));
      }
    }

    await recordDelivery({
      id: deliveryId,
      webhookId: webhook.id,
      event: event.kind,
      payload,
      responseStatus,
      responseBody,
      success,
      attempts,
    });
  }

  async function defaultDispatchWebhook(event: NoteDeletionCommittedEvent): Promise<void> {
    const webhooks = await adapter.queryMany<WebhookConfigRow>(
      `SELECT id, url, secret, events
         FROM webhooks
        WHERE "userId" = ? AND "isActive" = ?`,
      [event.actorUserId, true],
    );

    for (const webhook of webhooks) {
      const events = parseWebhookEvents(webhook.events);
      if (!events.includes("*") && !events.includes(event.kind)) continue;
      const delivery = deliverWebhook(webhook, event).catch((error) => {
        console.warn(
          `[note-deletion-effects-runtime] webhook delivery failed ${webhook.id}:`,
          errorMessage(error),
        );
      });
      pendingDeliveries.add(delivery);
      void delivery.finally(() => pendingDeliveries.delete(delivery));
    }
  }

  const recordAudit = options.recordAudit ?? defaultRecordAudit;
  const dispatchWebhook = options.dispatchWebhook ?? defaultDispatchWebhook;
  const publishRealtime = options.publishRealtime ?? (() => {});

  async function dispatch(event: NoteDeletionCommittedEvent): Promise<string[]> {
    const warnings: string[] = [];
    try {
      await recordAudit(event);
    } catch (error) {
      warnings.push(`audit side effect failed: ${errorMessage(error)}`);
    }

    try {
      await dispatchWebhook(event);
    } catch (error) {
      warnings.push(`webhook side effect failed: ${errorMessage(error)}`);
    }

    try {
      await publishRealtime(event);
    } catch (error) {
      warnings.push(`realtime side effect failed: ${errorMessage(error)}`);
    }
    return warnings;
  }

  async function shutdown(): Promise<void> {
    await Promise.allSettled(Array.from(pendingDeliveries));
  }

  return { dispatch, shutdown };
}

export default createNoteDeletionEffectsRuntime;
