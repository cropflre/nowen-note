import crypto from "node:crypto";
import { getUserWorkspaceRole } from "../middleware/acl.js";
import { AppBridgeSessionGuardV3, APP_BRIDGE_V3_MAX_BYTES, type AppBridgeResponseV3 } from "./appBridgeV3.js";
import { buildAppRegistryV3, getApplicationV3FeatureFlags, type AppPlatformV3 } from "./applicationV3.js";
import { buildAppDocumentV3 } from "./appDocumentV3.js";
import { compatibilityInputFromRecord } from "./extensionCompatibility.js";
import { pluginManifestV3Schema } from "./manifest.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginPermissions } from "./permissions.js";
import type { ExtensionPolicy } from "./extensionPolicy.js";
import type { HostApiBroker } from "./hostApiBroker.js";
import type { PluginManifestV3 } from "./types.js";

const TTL = 20 * 60 * 1000;
const NAVIGATION = new Set(["all", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares"]);
export interface AppActorV3 { userId: string; credential: string }
interface AppSessionV3 {
  guard: AppBridgeSessionGuardV3; actor: AppActorV3; workspaceId: string | null;
  version: string; checksum: string; grants: string; expiresAt: number;
  platform: AppPlatformV3; theme: "light" | "dark"; listeners: Set<() => void>;
}
function deny(code = "PLUGIN_UI_SESSION_REVOKED"): never { throw Object.assign(new Error(code), { code }); }

export class AppRuntimeV3 {
  private readonly sessions = new Map<string, AppSessionV3>();
  private readonly documents = new Map<string, { id: string; html: string; expiresAt: number }>();
  constructor(private registry: PluginRegistry, private permissions: PluginPermissions, private policy: ExtensionPolicy, private broker: HostApiBroker) {}

  private grants(pluginId: string): string {
    return JSON.stringify(this.permissions.list(pluginId).map(row => [row.permission, row.granted, row.configJson, row.grantedAt]));
  }
  eligible(pluginId: string) {
    if (!getApplicationV3FeatureFlags().appPages) deny("PLUGIN_V3_FEATURE_DISABLED");
    const record = this.registry.get(pluginId);
    if (!record || record.apiVersion !== 3 || record.status !== "enabled" || record.activeOperationId || record.lifecycleState !== "stable" || !this.permissions.allDeclaredGranted(pluginId)) deny();
    this.policy.assertAllowed(compatibilityInputFromRecord(record));
    return record;
  }
  create(pluginId: string, pageId: string, actor: AppActorV3, input: { workspaceId?: unknown; platform?: unknown; theme?: unknown }) {
    if (!actor.userId || !actor.credential) deny("RESOURCE_FORBIDDEN");
    const platform = input.platform || "web";
    if (platform !== "web" && platform !== "desktop") deny("PLUGIN_UI_PLATFORM_UNSUPPORTED");
    const workspaceId = input.workspaceId === null || input.workspaceId === undefined || input.workspaceId === "personal" ? null : input.workspaceId;
    if (typeof workspaceId !== "string" && workspaceId !== null) deny("RESOURCE_FORBIDDEN");
    if (workspaceId && !getUserWorkspaceRole(workspaceId, actor.userId)) deny("RESOURCE_FORBIDDEN");
    const record = this.eligible(pluginId);
    const manifest = pluginManifestV3Schema.parse(JSON.parse(record.manifestJson)) as PluginManifestV3;
    const page = buildAppRegistryV3([record], platform).find(page => page.id === pageId);
    if (!page) deny("PLUGIN_UI_PAGE_NOT_FOUND");
    for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) this.revoke(id);
    for (const document of this.documents.values()) if (document.expiresAt <= Date.now()) this.revoke(document.id);
    if (this.sessions.size >= 128 || [...this.sessions.values()].filter(session => session.actor.userId === actor.userId).length >= 8) deny("PLUGIN_UI_RATE_LIMITED");
    const identity = { pluginId, instanceId: crypto.randomUUID(), nonce: crypto.randomBytes(32).toString("hex") };
    const document = buildAppDocumentV3(record.installedPath, manifest, page.entry, identity);
    if ([...this.documents.values()].reduce((size, document) => size + Buffer.byteLength(document.html), Buffer.byteLength(document)) > 16 * 1024 * 1024) deny("PLUGIN_UI_RATE_LIMITED");
    const expiresAt = Date.now() + TTL;
    this.sessions.set(identity.instanceId, {
      guard: new AppBridgeSessionGuardV3(identity), actor: { ...actor }, workspaceId,
      version: record.version, checksum: record.checksum, grants: this.grants(pluginId), expiresAt,
      platform, theme: input.theme === "dark" ? "dark" : "light", listeners: new Set(),
    });
    const ticket = crypto.randomBytes(32).toString("hex");
    this.documents.set(ticket, { id: identity.instanceId, html: document, expiresAt: Date.now() + 30000 });
    return { ...identity, expiresAt, documentPath: `/plugin-ui-v3/${ticket}` };
  }
  takeDocument(ticket: string): string {
    const document = this.documents.get(ticket); this.documents.delete(ticket);
    if (!document || document.expiresAt <= Date.now()) deny();
    const session = this.sessions.get(document.id); if (!session) deny();
    this.check(document.id, session.guard.session.nonce, session.actor);
    return document.html;
  }
  check(id: string, nonce: string, actor: AppActorV3): AppSessionV3 {
    const session = this.sessions.get(id);
    if (!session || session.actor.userId !== actor.userId || session.actor.credential !== actor.credential || session.guard.session.nonce !== nonce) deny();
    try {
      const record = this.eligible(session.guard.session.pluginId);
      if (session.expiresAt <= Date.now() || record.version !== session.version || record.checksum !== session.checksum || session.grants !== this.grants(record.id)) deny();
      if (session.workspaceId && !getUserWorkspaceRole(session.workspaceId, actor.userId)) deny("RESOURCE_FORBIDDEN");
    } catch (error) { this.revoke(id); throw error; }
    return session;
  }
  async call(id: string, actor: AppActorV3, message: unknown): Promise<AppBridgeResponseV3> {
    const nonce = (message as { nonce?: string } | null)?.nonce;
    const session = this.check(id, typeof nonce === "string" ? nonce : "", actor);
    const request = session.guard.accept(message);
    try {
      let data: unknown;
      if (request.method === "context.get") data = { protocol: "nowen.plugin-ui.v3", methods: ["context.get", "storage.get", "storage.set", "storage.delete", "navigation.open", "data.query", "data.get", "data.put", "data.delete", "data.migrate", "data.restore", "notes.list", "tasks.list"], workspaceId: session.workspaceId, theme: session.theme, platform: session.platform };
      else if (request.method.startsWith("data.") || ["notes.list", "tasks.list"].includes(request.method)) {
        const context = { executionId: id, pluginId: session.guard.session.pluginId, actionId: "ui", userId: actor.userId, workspaceId: session.workspaceId };
        if (request.method.startsWith("data.")) data = await this.broker.call(context, { method: request.method, args: request.params });
        else {
          if (Object.keys(request.params).length) deny("PLUGIN_UI_INVALID_PAYLOAD");
          const items = await this.broker.call(context, { method: request.method, args: { limit: 20, metadataOnly: true } }) as Array<Record<string, unknown>>;
          data = items.filter(row => (row.workspaceId || null) === session.workspaceId).map(row => ({ id: row.id, title: row.title, updatedAt: row.updatedAt, ...(request.method === "tasks.list" ? { status: row.status } : {}) }));
        }
      }
      else if (["storage.get", "storage.set", "storage.delete"].includes(request.method)) {
        if (Object.keys(request.params).some(key => !["key", "value"].includes(key))) deny("PLUGIN_UI_INVALID_PAYLOAD");
        // Scope and identity come exclusively from the authenticated host session.
        data = await this.broker.call({ executionId: id, pluginId: session.guard.session.pluginId, actionId: "ui", userId: actor.userId, workspaceId: session.workspaceId }, {
          method: request.method, args: { ...request.params, scopeType: session.workspaceId ? "workspace" : "user", scopeId: session.workspaceId },
        });
      } else if (request.method === "navigation.open") {
        if (Object.keys(request.params).some(key => !["target", "noteId"].includes(key))) deny("PLUGIN_UI_INVALID_PAYLOAD");
        if (typeof request.params.target !== "string" || !NAVIGATION.has(request.params.target)) deny("PLUGIN_UI_NAVIGATION_DENIED");
        data = { target: request.params.target };
        if (request.params.noteId !== undefined) {
          if (request.params.target !== "all" || typeof request.params.noteId !== "string") deny("PLUGIN_UI_NAVIGATION_DENIED");
          const note = await this.broker.call({ executionId: id, pluginId: session.guard.session.pluginId, actionId: "ui", userId: actor.userId, workspaceId: session.workspaceId }, { method: "notes.get", args: { id: request.params.noteId } }) as { workspaceId?: string } | null;
          if (!note || (note.workspaceId || null) !== session.workspaceId) deny("RESOURCE_FORBIDDEN");
          data = { target: "all", noteId: request.params.noteId };
        }
      } else deny("HOST_METHOD_UNSUPPORTED");
      this.check(id, nonce!, actor);
      const response: AppBridgeResponseV3 = { protocol: request.protocol, kind: "response", pluginId: request.pluginId, instanceId: id, requestId: request.requestId, ok: true, data };
      if (Buffer.byteLength(JSON.stringify(response)) > APP_BRIDGE_V3_MAX_BYTES) deny("PLUGIN_UI_RESULT_TOO_LARGE");
      return response;
    } finally { session.guard.complete(request.requestId); }
  }
  subscribe(id: string, nonce: string, actor: AppActorV3, listener: () => void): () => void {
    const session = this.check(id, nonce, actor); session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }
  revoke(id: string): void {
    const session = this.sessions.get(id); if (!session) return;
    this.sessions.delete(id); session.guard.revoke();
    for (const [ticket, document] of this.documents) if (document.id === id) this.documents.delete(ticket);
    for (const listener of session.listeners) listener(); session.listeners.clear();
  }
  revokePlugin(pluginId: string): void { for (const [id, session] of this.sessions) if (session.guard.session.pluginId === pluginId) this.revoke(id); }
}
