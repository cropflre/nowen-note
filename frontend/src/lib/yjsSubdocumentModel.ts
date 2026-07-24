import * as Y from "yjs";

export interface TiptapSubdocumentSection {
  id: string;
  guid: string;
  startBlock: number;
  endBlock: number;
  content: string;
}

export interface TiptapSubdocumentBundle {
  rootDoc: Y.Doc;
  sections: TiptapSubdocumentSection[];
  subdocuments: Map<string, Y.Doc>;
}

export interface TiptapSubdocumentTransport {
  send(sectionId: string, update: Uint8Array): boolean;
}

export interface TiptapSubdocumentSyncController {
  applyRemote(sectionId: string, update: Uint8Array): boolean;
  flushPending(): number;
  pendingCount(): number;
  destroy(): void;
}

export interface TiptapSubdocumentRestTransport {
  load(sectionId: string): Promise<{ guid: string; state: Uint8Array }>;
  send(sectionId: string, update: Uint8Array, generation: number): Promise<void>;
}

export interface TiptapSubdocumentGenerationManifest {
  generation: number;
  structureVersion: number;
  sections: unknown[];
}

export interface TiptapSubdocumentRestSyncOptions {
  generation?: number;
  manifest?: TiptapSubdocumentGenerationManifest;
  onGenerationConflict?: (manifest: TiptapSubdocumentGenerationManifest) => void;
}

export interface TiptapSubdocumentRestSyncController {
  loadSection(sectionId: string): Promise<string | null>;
  updateSectionContent(sectionId: string, content: string): boolean;
  applyRemote(sectionId: string, update: Uint8Array): boolean;
  flushPending(): Promise<number>;
  pendingCount(): number;
  destroy(preservePending?: boolean): void;
}

const SUBDOCUMENT_PENDING_STORAGE_PREFIX = "nowen:yjs-subdocument-pending:";

function encodePendingUpdate(update: Uint8Array): string {
  let binary = "";
  for (const byte of update) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodePendingUpdate(value: string): Uint8Array {
  const binary = atob(value);
  if (!binary) throw new Error("空的 Subdocument pending update");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseDocument(content: string): { type: "doc"; content: any[] } | null {
  try {
    const value = JSON.parse(content);
    if (value?.type !== "doc" || !Array.isArray(value.content)) return null;
    return { type: "doc", content: value.content };
  } catch {
    return null;
  }
}

function stablePart(value: unknown): string {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function sectionIdentity(noteId: string, nodes: any[], index: number): { id: string; guid: string } {
  const blockId = nodes.find((node) => typeof node?.attrs?.blockId === "string")?.attrs?.blockId;
  const id = blockId ? `section-${stablePart(blockId)}` : `section-${index}`;
  return { id, guid: `nowen-subdoc-${stablePart(noteId)}-${id}` };
}

/** 一级/二级标题优先分章；无标题长文按顶层 Block 数上限切分。 */
export function splitTiptapSubdocumentSections(
  noteId: string,
  content: string,
  maxBlocks = 250,
): TiptapSubdocumentSection[] | null {
  const doc = parseDocument(content);
  if (!doc || !Number.isInteger(maxBlocks) || maxBlocks < 10) return null;
  if (doc.content.length === 0) {
    const identity = sectionIdentity(noteId, [], 0);
    return [{ ...identity, startBlock: 0, endBlock: 0, content: JSON.stringify({ type: "doc", content: [] }) }];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 1; index < doc.content.length; index += 1) {
    const node = doc.content[index];
    const headingBoundary = node?.type === "heading" && Number(node?.attrs?.level) <= 2;
    if (headingBoundary || index - start >= maxBlocks) {
      ranges.push({ start, end: index });
      start = index;
    }
  }
  ranges.push({ start, end: doc.content.length });
  const used = new Set<string>();
  return ranges.map((range, index) => {
    const nodes = doc.content.slice(range.start, range.end);
    const identity = sectionIdentity(noteId, nodes, index);
    let id = identity.id;
    if (used.has(id)) id = `${id}-${index}`;
    used.add(id);
    return {
      id,
      guid: id === identity.id ? identity.guid : `nowen-subdoc-${stablePart(noteId)}-${id}`,
      startBlock: range.start,
      endBlock: range.end,
      content: JSON.stringify({ type: "doc", content: nodes }),
    };
  });
}

export function createTiptapSubdocumentBundle(
  noteId: string,
  content: string,
  maxBlocks = 250,
  options: { preload?: boolean } = {},
): TiptapSubdocumentBundle | null {
  const sections = splitTiptapSubdocumentSections(noteId, content, maxBlocks);
  if (!sections) return null;
  const rootDoc = new Y.Doc({ guid: `nowen-root-${stablePart(noteId)}` });
  const order = rootDoc.getArray<string>("sectionOrder");
  const sectionMap = rootDoc.getMap<Y.Doc>("sections");
  const metadata = rootDoc.getMap<unknown>("metadata");
  const subdocuments = new Map<string, Y.Doc>();
  rootDoc.transact(() => {
    metadata.set("version", 1);
    metadata.set("noteId", noteId);
    order.insert(0, sections.map((section) => section.id));
    if (options.preload !== false) {
      for (const section of sections) {
        const subdoc = new Y.Doc({ guid: section.guid, autoLoad: false });
        subdoc.getText("content").insert(0, section.content);
        sectionMap.set(section.id, subdoc);
        subdocuments.set(section.id, subdoc);
      }
    }
  }, "subdocument-bootstrap");
  return { rootDoc, sections, subdocuments };
}

export function materializeTiptapSubdocuments(bundle: TiptapSubdocumentBundle): string | null {
  const order = bundle.rootDoc.getArray<string>("sectionOrder").toArray();
  const nodes: any[] = [];
  for (const sectionId of order) {
    const subdoc = bundle.subdocuments.get(sectionId) || bundle.rootDoc.getMap<Y.Doc>("sections").get(sectionId);
    const section = subdoc ? parseDocument(subdoc.getText("content").toString()) : null;
    if (!section) return null;
    nodes.push(...section.content);
  }
  return JSON.stringify({ type: "doc", content: nodes });
}

export function destroyTiptapSubdocumentBundle(bundle: TiptapSubdocumentBundle): void {
  for (const subdoc of bundle.subdocuments.values()) subdoc.destroy();
  bundle.subdocuments.clear();
  bundle.rootDoc.destroy();
}

/** 离线时按章节合并更新；恢复连接后逐章发送，远端 update 不回声。 */
export function createTiptapSubdocumentSyncController(
  bundle: TiptapSubdocumentBundle,
  transport: TiptapSubdocumentTransport,
): TiptapSubdocumentSyncController {
  const pending = new Map<string, Uint8Array>();
  const removers: Array<() => void> = [];
  const controller: TiptapSubdocumentSyncController = {
    applyRemote: (sectionId, update) => {
      const doc = bundle.subdocuments.get(sectionId);
      if (!doc) return false;
      Y.applyUpdate(doc, update, controller);
      return true;
    },
    flushPending: () => {
      let sent = 0;
      for (const [sectionId, update] of [...pending]) {
        if (!transport.send(sectionId, update)) continue;
        pending.delete(sectionId);
        sent += 1;
      }
      return sent;
    },
    pendingCount: () => pending.size,
    destroy: () => {
      for (const remove of removers) remove();
      removers.length = 0;
      pending.clear();
    },
  };
  for (const [sectionId, doc] of bundle.subdocuments) {
    const listener = (update: Uint8Array, origin: unknown) => {
      if (origin === controller || transport.send(sectionId, update)) return;
      const previous = pending.get(sectionId);
      pending.set(sectionId, previous ? Y.mergeUpdates([previous, update]) : update);
    };
    doc.on("update", listener);
    removers.push(() => doc.off("update", listener));
  }
  return controller;
}

/** REST 章节同步：只为已加载章节建监听，失败增量按章节合并并等待显式重试。 */
export function createTiptapSubdocumentRestSyncController(
  bundle: TiptapSubdocumentBundle,
  transport: TiptapSubdocumentRestTransport,
  options: TiptapSubdocumentRestSyncOptions = {},
): TiptapSubdocumentRestSyncController {
  const pending = new Map<string, Uint8Array>();
  const inflight = new Map<string, Uint8Array>();
  const loading = new Map<string, Promise<string | null>>();
  const loaded = new Set<string>();
  const removers = new Map<string, () => void>();
  const noteId = String(bundle.rootDoc.getMap<unknown>("metadata").get("noteId") || "");
  const storageKey = `${SUBDOCUMENT_PENDING_STORAGE_PREFIX}${encodeURIComponent(noteId)}`;
  const validSectionIds = new Set(bundle.sections.map((section) => section.id));
  const generation = options.generation ?? 1;
  let destroyed = false;

  const canSendNow = () => typeof navigator === "undefined" || navigator.onLine !== false;
  const persistPending = () => {
    if (!noteId || typeof localStorage === "undefined") return;
    try {
      const sectionIds = new Set([...pending.keys(), ...inflight.keys()]);
      if (sectionIds.size === 0) {
        localStorage.removeItem(storageKey);
        return;
      }
      const sections: Record<string, string> = {};
      for (const sectionId of sectionIds) {
        const queued = pending.get(sectionId);
        const sending = inflight.get(sectionId);
        const update = queued && sending
          ? Y.mergeUpdates([sending, queued])
          : queued || sending;
        if (update) sections[sectionId] = encodePendingUpdate(update);
      }
      localStorage.setItem(storageKey, JSON.stringify({ version: 2, generation, sections }));
    } catch {
      // localStorage 配额或禁用时保留内存 pending；不把不完整记录写回。
    }
  };
  const restorePending = () => {
    if (!noteId || typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { version?: unknown; generation?: unknown; sections?: unknown };
      const persistedGeneration = parsed.version === 1 ? 1 : parsed.generation;
      if (
        ![1, 2].includes(Number(parsed.version))
        || !Number.isInteger(persistedGeneration)
        || Number(persistedGeneration) < 1
        || !parsed.sections
        || typeof parsed.sections !== "object"
        || Array.isArray(parsed.sections)
      ) {
        throw new Error("Subdocument pending 格式无效");
      }
      if (persistedGeneration !== generation) {
        if (options.manifest) options.onGenerationConflict?.(options.manifest);
        return;
      }
      for (const [sectionId, encoded] of Object.entries(parsed.sections as Record<string, unknown>)) {
        if (!validSectionIds.has(sectionId) || typeof encoded !== "string") continue;
        const update = decodePendingUpdate(encoded);
        // mergeUpdates 会解析 update；损坏二进制必须 fail-closed，不能留到发送阶段。
        pending.set(sectionId, Y.mergeUpdates([update]));
      }
      persistPending();
    } catch {
      pending.clear();
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
  };
  const mergePending = (sectionId: string, update: Uint8Array) => {
    const previous = pending.get(sectionId);
    pending.set(sectionId, previous ? Y.mergeUpdates([previous, update]) : update);
    persistPending();
  };
  const attach = (sectionId: string, doc: Y.Doc) => {
    removers.get(sectionId)?.();
    const listener = (update: Uint8Array, origin: unknown) => {
      if (destroyed || origin === controller) return;
      mergePending(sectionId, update);
      if (canSendNow()) void sendSection(sectionId);
    };
    doc.on("update", listener);
    removers.set(sectionId, () => doc.off("update", listener));
  };
  const sendSection = async (sectionId: string): Promise<boolean> => {
    if (destroyed || inflight.has(sectionId) || !canSendNow()) return false;
    const update = pending.get(sectionId);
    if (!update) return false;
    pending.delete(sectionId);
    inflight.set(sectionId, update);
    persistPending();
    let sent = false;
    try {
      await transport.send(sectionId, update, generation);
      sent = true;
      inflight.delete(sectionId);
      persistPending();
      return true;
    } catch (error) {
      inflight.delete(sectionId);
      if (!destroyed) {
        mergePending(sectionId, update);
        const conflict = error as {
          code?: string;
          manifest?: TiptapSubdocumentGenerationManifest;
        };
        if (conflict?.code === "SUBDOCUMENT_GENERATION_CONFLICT" && conflict.manifest) {
          options.onGenerationConflict?.(conflict.manifest);
        }
      }
      return false;
    } finally {
      if (sent && !destroyed && canSendNow() && pending.has(sectionId)) void sendSection(sectionId);
    }
  };

  restorePending();

  const controller: TiptapSubdocumentRestSyncController = {
    loadSection: (sectionId) => {
      if (destroyed) return Promise.resolve(null);
      const existing = bundle.subdocuments.get(sectionId);
      if (loaded.has(sectionId) && existing) return Promise.resolve(existing.getText("content").toString());
      const inflight = loading.get(sectionId);
      if (inflight) return inflight;
      const section = bundle.sections.find((candidate) => candidate.id === sectionId);
      if (!section) return Promise.resolve(null);
      const request = transport.load(sectionId).then(({ guid, state }) => {
        if (destroyed) return null;
        if (guid !== section.guid) throw new Error(`Subdocument GUID 不匹配: ${sectionId}`);
        const doc = new Y.Doc({ guid, autoLoad: false });
        try {
          Y.applyUpdate(doc, state, controller);
          const restoredPending = pending.get(sectionId);
          if (restoredPending) Y.applyUpdate(doc, restoredPending, controller);
          const content = doc.getText("content").toString();
          if (!parseDocument(content)) throw new Error(`Subdocument 内容无效: ${sectionId}`);
          const previous = bundle.subdocuments.get(sectionId);
          bundle.rootDoc.getMap<Y.Doc>("sections").set(sectionId, doc);
          bundle.subdocuments.set(sectionId, doc);
          removers.get(sectionId)?.();
          previous?.destroy();
          attach(sectionId, doc);
          loaded.add(sectionId);
          return content;
        } catch (error) {
          doc.destroy();
          throw error;
        }
      }).finally(() => loading.delete(sectionId));
      loading.set(sectionId, request);
      return request;
    },
    updateSectionContent: (sectionId, content) => {
      if (destroyed || !loaded.has(sectionId) || !parseDocument(content)) return false;
      const doc = bundle.subdocuments.get(sectionId);
      if (!doc) return false;
      const text = doc.getText("content");
      if (text.toString() === content) return true;
      doc.transact(() => {
        if (text.length > 0) text.delete(0, text.length);
        text.insert(0, content);
      }, "subdocument-rest-edit");
      return true;
    },
    applyRemote: (sectionId, update) => {
      if (destroyed || !loaded.has(sectionId)) return false;
      const doc = bundle.subdocuments.get(sectionId);
      if (!doc) return false;
      Y.applyUpdate(doc, update, controller);
      return true;
    },
    flushPending: async () => {
      if (destroyed || !canSendNow()) return 0;
      let sent = 0;
      for (const sectionId of [...pending.keys()]) {
        if (await sendSection(sectionId)) sent += 1;
      }
      return sent;
    },
    pendingCount: () => new Set([...pending.keys(), ...inflight.keys()]).size,
    destroy: (preservePending = false) => {
      destroyed = true;
      for (const remove of removers.values()) remove();
      removers.clear();
      if (!preservePending) {
        pending.clear();
        inflight.clear();
      }
      loading.clear();
      loaded.clear();
    },
  };
  return controller;
}
