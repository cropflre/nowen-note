// Wire-format validation only. A browser host MUST additionally bind a dedicated
// MessagePort to the expected iframe.contentWindow; opaque origin "null" is not identity.
// No method in this file directly invokes Host API or grants permissions.
export const APP_BRIDGE_V3_PROTOCOL = "nowen.plugin-ui.v3";
export const APP_BRIDGE_V3_MAX_BYTES = 64 * 1024;
export const APP_BRIDGE_V3_MAX_IN_FLIGHT = 16;
export const APP_BRIDGE_V3_MAX_CALLS_PER_MINUTE = 120;
export const APP_BRIDGE_V3_MAX_REQUESTS_PER_SESSION = 4096;

export const APP_BRIDGE_V3_METHODS = [
  "context.get",
  "storage.get",
  "storage.set",
  "storage.delete",
  "action.execute",
  "navigation.open",
  "notification.show",
] as const;

export type AppBridgeV3Method = typeof APP_BRIDGE_V3_METHODS[number];
const ALLOWED_METHODS = new Set<string>(APP_BRIDGE_V3_METHODS);
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AppBridgeRequestV3 {
  protocol: typeof APP_BRIDGE_V3_PROTOCOL;
  kind: "request";
  pluginId: string;
  instanceId: string;
  nonce: string;
  requestId: string;
  method: AppBridgeV3Method;
  params: Record<string, unknown>;
}

export interface AppBridgeSessionV3 {
  pluginId: string;
  instanceId: string;
  nonce: string;
}

export interface AppBridgeResponseV3 {
  protocol: typeof APP_BRIDGE_V3_PROTOCOL;
  kind: "response";
  pluginId: string;
  instanceId: string;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

function reject(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkJsonShape(value: unknown, depth = 0): void {
  if (depth > 16) reject("PLUGIN_UI_INVALID_PAYLOAD");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1000) reject("PLUGIN_UI_INVALID_PAYLOAD");
    for (const item of value) checkJsonShape(item, depth + 1);
    return;
  }
  if (!plainObject(value)) reject("PLUGIN_UI_INVALID_PAYLOAD");
  const keys = Object.keys(value);
  if (keys.length > 100 || keys.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) {
    reject("PLUGIN_UI_INVALID_PAYLOAD");
  }
  for (const key of keys) checkJsonShape(value[key], depth + 1);
}

export function validateAppBridgeRequestV3(value: unknown, session: AppBridgeSessionV3): AppBridgeRequestV3 {
  if (!plainObject(value)) reject("PLUGIN_UI_INVALID_MESSAGE");
  const fields = Object.keys(value);
  if (fields.some((field) => !["protocol", "kind", "pluginId", "instanceId", "nonce", "requestId", "method", "params"].includes(field))) {
    reject("PLUGIN_UI_INVALID_MESSAGE");
  }
  if (value.protocol !== APP_BRIDGE_V3_PROTOCOL || value.kind !== "request" ||
    value.pluginId !== session.pluginId || value.instanceId !== session.instanceId ||
    value.nonce !== session.nonce || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId) ||
    typeof value.method !== "string" || !ALLOWED_METHODS.has(value.method) || !plainObject(value.params)) {
    reject("PLUGIN_UI_INVALID_MESSAGE");
  }
  checkJsonShape(value.params);
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    reject("PLUGIN_UI_INVALID_PAYLOAD");
  }
  if (bytes > APP_BRIDGE_V3_MAX_BYTES) reject("PLUGIN_UI_MESSAGE_TOO_LARGE");
  return value as unknown as AppBridgeRequestV3;
}

export class AppBridgeSessionGuardV3 {
  private readonly pending = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly calls: number[] = [];
  private active = true;

  constructor(readonly session: AppBridgeSessionV3) {
    if (!PLUGIN_ID.test(session.pluginId) || !SAFE_ID.test(session.instanceId) || !SAFE_ID.test(session.nonce)) {
      reject("PLUGIN_UI_INVALID_SESSION");
    }
  }

  accept(message: unknown, nowMs = Date.now()): AppBridgeRequestV3 {
    if (!this.active) reject("PLUGIN_UI_SESSION_REVOKED");
    const parsed = validateAppBridgeRequestV3(message, this.session);
    while (this.calls.length && this.calls[0] <= nowMs - 60_000) this.calls.shift();
    if (this.seen.has(parsed.requestId)) reject("PLUGIN_UI_DUPLICATE_REQUEST");
    if (this.seen.size >= APP_BRIDGE_V3_MAX_REQUESTS_PER_SESSION) {
      this.revoke();
      reject("PLUGIN_UI_SESSION_EXHAUSTED");
    }
    if (this.pending.size >= APP_BRIDGE_V3_MAX_IN_FLIGHT || this.calls.length >= APP_BRIDGE_V3_MAX_CALLS_PER_MINUTE) {
      reject("PLUGIN_UI_RATE_LIMITED");
    }
    this.pending.add(parsed.requestId);
    this.seen.add(parsed.requestId);
    this.calls.push(nowMs);
    return parsed;
  }

  complete(requestId: string): void {
    this.pending.delete(requestId);
  }

  revoke(): void {
    this.active = false;
    this.pending.clear();
    this.seen.clear();
    this.calls.length = 0;
  }
}
