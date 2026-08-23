import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import type { AutomationSource, NowenEvent } from "./types.js";

export const MAX_EVENT_DEPTH = 10;
const EVENT_RETENTION_DAYS = 14;

export interface PublishEventInput {
  id?: string;
  type: string;
  userId: string;
  workspaceId?: string | null;
  resourceType: string;
  resourceId: string;
  source?: AutomationSource;
  sourceId?: string;
  correlationId?: string;
  causationId?: string;
  depth?: number;
  batchId?: string;
  replayedFrom?: string;
  data?: Record<string, unknown>;
  occurredAt?: string;
}

export function rowToEvent(row: Record<string, unknown>): NowenEvent {
  const workspaceId = typeof row.workspaceId === "string" && row.workspaceId ? row.workspaceId : undefined;
  return {
    id: String(row.id),
    type: String(row.type),
    apiVersion: 1,
    occurredAt: String(row.occurredAt),
    actor: { userId: String(row.userId) },
    scope: workspaceId ? { type: "workspace", workspaceId } : { type: "personal" },
    resource: { type: String(row.resourceType), id: String(row.resourceId) },
    data: JSON.parse(String(row.payloadJson || "{}")) as Record<string, unknown>,
    metadata: {
      source: String(row.source) as AutomationSource,
      ...(row.sourceId ? { sourceId: String(row.sourceId) } : {}),
      correlationId: String(row.correlationId),
      ...(row.causationId ? { causationId: String(row.causationId) } : {}),
      depth: Number(row.depth) || 0,
      ...(row.batchId ? { batchId: String(row.batchId), bulkImport: true } : {}),
      ...(row.replayedFrom ? { replayedFrom: String(row.replayedFrom) } : {}),
    },
  };
}

export class EventPublisher {
  publish(input: PublishEventInput): NowenEvent {
    const depth = Math.max(0, Math.floor(input.depth || 0));
    if (depth > MAX_EVENT_DEPTH) throw Object.assign(new Error("自动化事件递归深度超过 10"), { code: "AUTOMATION_LOOP_DETECTED" });
    const occurredAt = input.occurredAt || new Date().toISOString();
    const id = input.id || crypto.randomUUID();
    const correlationId = input.correlationId || id;
    const expiresAt = new Date(Date.parse(occurredAt) + EVENT_RETENTION_DAYS * 86400000).toISOString();
    getDb().prepare(`INSERT OR IGNORE INTO automation_events
      (id,type,apiVersion,userId,workspaceId,resourceType,resourceId,source,sourceId,correlationId,causationId,depth,batchId,replayedFrom,payloadJson,dispatchState,occurredAt,createdAt,expiresAt)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`)
      .run(id, input.type, input.userId, input.workspaceId || null, input.resourceType, input.resourceId, input.source || "user", input.sourceId || null,
        correlationId, input.causationId || null, depth, input.batchId || null, input.replayedFrom || null, JSON.stringify(input.data || {}), occurredAt, new Date().toISOString(), expiresAt);
    const row = getDb().prepare("SELECT * FROM automation_events WHERE id=?").get(id) as Record<string, unknown>;
    return rowToEvent(row);
  }

  replay(eventId: string, actorUserId: string): NowenEvent {
    const row = getDb().prepare("SELECT * FROM automation_events WHERE id=?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("事件不存在"), { code: "AUTOMATION_EVENT_NOT_FOUND" });
    return this.publish({
      type: String(row.type), userId: actorUserId, workspaceId: row.workspaceId as string | null,
      resourceType: String(row.resourceType), resourceId: String(row.resourceId), source: "system",
      sourceId: "event-replay", correlationId: crypto.randomUUID(), causationId: eventId,
      replayedFrom: eventId, data: JSON.parse(String(row.payloadJson || "{}")),
    });
  }

  list(userId: string, isAdmin: boolean, limit = 100): NowenEvent[] {
    const rows = isAdmin
      ? getDb().prepare("SELECT * FROM automation_events ORDER BY occurredAt DESC LIMIT ?").all(Math.min(500, limit))
      : getDb().prepare("SELECT * FROM automation_events WHERE userId=? ORDER BY occurredAt DESC LIMIT ?").all(userId, Math.min(500, limit));
    return (rows as Record<string, unknown>[]).map(rowToEvent);
  }

  cleanup(): { events: number; runs: number; idempotency: number } {
    const now = new Date().toISOString();
    const runsCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const idempotencyCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const events = getDb().prepare("DELETE FROM automation_events WHERE expiresAt < ? AND dispatchState='dispatched'").run(now).changes;
    const runs = getDb().prepare("DELETE FROM automation_workflow_runs WHERE createdAt < ? AND status IN ('completed','cancelled')").run(runsCutoff).changes;
    const idempotency = getDb().prepare("DELETE FROM automation_idempotency WHERE createdAt < ?").run(idempotencyCutoff).changes;
    return { events, runs, idempotency };
  }
}

export const eventPublisher = new EventPublisher();
