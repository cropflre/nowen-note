import type { DatabaseSync } from "node:sqlite";

const SENSITIVE_KEY = /authorization|cookie|secret|token|password|signature|private.?key/i;

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen)]));
}
export interface AuditEvent {
  actorType: "developer" | "admin" | "system";
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export class AuditLog {
  constructor(private readonly db: DatabaseSync) {}

  append(event: AuditEvent): void {
    this.db.prepare(`INSERT INTO audit_log(actorType,actorId,action,targetType,targetId,metadataJson,ipAddress,createdAt)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      event.actorType, event.actorId || null, event.action, event.targetType, event.targetId || null,
      JSON.stringify(redact(event.metadata || {})), event.ipAddress || null, new Date().toISOString(),
    );
  }
}

export function safeLog(level: "info" | "warn" | "error", message: string, details: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...redact(details) as Record<string, unknown>, timestamp: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
