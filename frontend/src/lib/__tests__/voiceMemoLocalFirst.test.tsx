import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeDatabase } from "../nativeDatabase";
import type { NativeAttachmentStore } from "../nativeAttachmentStore";

// 只隔离无关业务门面；笔记写入、Outbox 序列化、同步请求和音频渲染使用真实实现。
vi.mock("@/lib/api", async () => {
  const bridge = await import("@/lib/noteAttachmentAccessBridge");
  return { api: { attachments: {}, attachmentFolders: {} }, resolveAttachmentUrl: bridge.resolveAttachmentAccessUrl };
});
vi.mock("../mobileLocalMode", () => ({ isMobileLocalMode: () => false }));
vi.mock("../mobileLocalKnowledgeTreeBridge", () => ({ installMobileLocalKnowledgeTreeBridge: () => () => undefined }));
vi.mock("../mobileLocalModuleBridge", () => ({ installMobileLocalModuleBridge: () => () => undefined }));
vi.mock("../mobileLocalAdvancedTaskBridge", () => ({ installMobileLocalAdvancedTaskBridge: () => () => undefined }));
vi.mock("../mobileLocalAttachmentFolderBridge", () => ({ installMobileLocalAttachmentFolderBridge: () => () => undefined }));
vi.mock("../mobileLocalNoteRelationsBridge", () => ({ installMobileLocalNoteRelationsBridge: () => () => undefined }));
import { api } from "../api";
import { installMobileLocalFirstBridge } from "../mobileLocalFirstBridge";
import { NativeLocalRepository } from "../nativeLocalRepository";
import { MobileSyncEngine } from "../mobileSyncEngine";
import { registerNativeAttachmentUrl, registerAttachmentAccessUrls, resetAttachmentAccessStateForTests, getAttachmentRenderSource } from "../noteAttachmentAccessBridge";
import VoiceMemoAudio from "@/components/VoiceMemoAudio";

const ID = "123e4567-e89b-42d3-a456-426614174216";
const localUrl = "https://localhost/_capacitor_file_/data/user/0/voice.webm";
const stableUrl = `/api/attachments/${ID}`;
const scope = { scopeKey: "personal", workspaceId: null, workspaceName: null, role: null, canWrite: true, accessFingerprint: "test" };

// 内存数据库替身记录真实 SQL 的入参，不自行生成正文或同步载荷。
function createDatabase() {
  const notes = new Map<string, Record<string, unknown>>();
  const outbox: Record<string, unknown>[] = [];
  const db: NativeDatabase = {
    async run(sql, values = []) {
      if (/INSERT INTO notes/.test(sql)) {
        const columns = sql.match(/INSERT INTO notes\s*\(([^)]+)\)/)![1].split(",").map((column) => column.trim());
        const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
        notes.set(String(row.id), row);
      } else if (/UPDATE notes SET/.test(sql)) {
        const row = notes.get(String(values.at(-1)))!;
        const columns = sql.match(/SET([\s\S]+?)WHERE/)![1].split(",").map((column) => column.trim().split("=")[0]);
        columns.forEach((column, index) => { row[column] = values[index]; });
      } else if (/INSERT INTO sync_outbox/.test(sql)) {
        outbox.push({ mutationId: values[1], entityType: values[5], entityId: values[6], operation: values[7], baseVersion: values[8], payload: values[9] });
      } else if (/DELETE FROM sync_outbox WHERE mutationId/.test(sql)) {
        const index = outbox.findIndex((row) => row.mutationId === values[0]);
        if (index !== -1) outbox.splice(index, 1);
      } else if (/INSERT INTO native_runtime_meta/.test(sql) || /DELETE FROM native_runtime_meta/.test(sql)) {
        // Unsynced-note marker: the fake DB has no persistent native metadata table.
      } else throw new Error(`未覆盖的 SQL: ${sql}`);
      return { changes: 1 };
    },
    async query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
      if (sql.includes("FROM sync_profiles p")) return [{ profileId: "profile", deviceId: "device" }] as T[];
      if (sql.includes("FROM sync_outbox")) return [...outbox] as T[];
      // Sync V2 reads scoped notes directly, while the local editor fetches by ID.
      // Both must resolve against the same in-memory rows.
      if (sql.includes("FROM notes WHERE scopeKey=? AND id=?")) {
        const row = notes.get(String(values[1]));
        return (row?.scopeKey === values[0] ? [row] : []) as T[];
      }
      if (sql.includes("FROM notes WHERE id")) return (notes.has(String(values[0])) ? [notes.get(String(values[0]))!] : []) as T[];
      if (sql.includes("FROM tags")) return [];
      throw new Error(`未覆盖的查询: ${sql}`);
    },
    transaction: async (work) => work(db),
    close: async () => undefined,
  };
  return { db, notes, outbox };
}
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; resetAttachmentAccessStateForTests(); vi.unstubAllGlobals(); });

describe("Android Local-first voice memo sync", () => {
  it.each(["tiptap-json", "markdown", "html"])("persists and syncs stable %s audio, then resolves it on another device", async (contentFormat) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetAttachmentAccessStateForTests();
    registerNativeAttachmentUrl(ID, localUrl);
    const { db, notes, outbox } = createDatabase();
    const attachments = {} as NativeAttachmentStore;
    const repository = new NativeLocalRepository({ db, attachments, accountId: "account", userId: "user", getScopeKey: () => "personal" });
    restore = installMobileLocalFirstBridge(repository, db, "user");
    const content = contentFormat === "tiptap-json"
      ? JSON.stringify({ type: "doc", content: [{ type: "voiceMemo", attrs: { attachmentId: ID, src: localUrl } }] })
      : `<audio controls data-attachment-id="${ID}"><source src="${localUrl}" type="audio/webm"></audio>`;
    const note = await api.createNote({ notebookId: "notebook", title: "语音", content, contentFormat });
    expect(notes.get(note.id)!.content).toContain(stableUrl);
    expect(notes.get(note.id)!.content).not.toContain("_capacitor_file_");
    // 更新门面和确认保存别名也必须穿过同一个持久化边界。
    await api.updateNoteConfirmed(note.id, { content, contentFormat });
    expect(outbox).toHaveLength(2);
    expect(outbox.every((row) => String(row.payload).includes(stableUrl) && !String(row.payload).includes(localUrl))).toBe(true);
    expect(getAttachmentRenderSource(stableUrl).resolvedSrc).toBe(localUrl);

    const requests: Array<{ mutations: Array<{ mutationId: string; payload: { content: string } }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      return { ok: true, json: async () => ({ serverSequence: 2, results: body.mutations.map((mutation: { mutationId: string }) => ({ mutationId: mutation.mutationId, status: "applied" })) }) };
    }));
    const engine = new MobileSyncEngine({ db, attachments, serverUrl: "https://server.example", token: "test", userId: "user", profileId: "profile", deviceId: "device" });
    await (engine as unknown as { push: (value: typeof scope) => Promise<void> }).push(scope);
    expect(fetch).toHaveBeenCalledWith("https://server.example/api/sync/v2/push?scopeKey=personal", expect.objectContaining({ method: "POST" }));
    expect(outbox).toHaveLength(0);
    const synced = requests[0].mutations.at(-1)!.payload.content;
    expect(synced).toContain(stableUrl); expect(synced).not.toContain(localUrl);
    const persistedSrc = contentFormat === "tiptap-json" ? JSON.parse(synced).content[0].attrs.src : new DOMParser().parseFromString(synced, "text/html").querySelector("source")!.getAttribute("src");

    // 清空第一台设备的本地文件映射，第二台设备仅获得同步正文和自己的签名地址。
    resetAttachmentAccessStateForTests();
    const signed = `https://server.example/api/attachments/${ID}?exp=2000000000&sig=second-device&scope=user`;
    registerAttachmentAccessUrls({ [ID]: signed }, "https://server.example/api/attachments/access/urls");
    const container = document.createElement("div"); const root = createRoot(container);
    try {
      await act(async () => root.render(<VoiceMemoAudio src={persistedSrc} />));
      expect(container.querySelector("audio")!.getAttribute("src")).toBe(`${signed}&inline=1`);
    } finally { await act(async () => root.unmount()); }
  });
});
