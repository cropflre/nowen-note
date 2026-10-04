// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN.json";
import type { TrashItem } from "../trashTypes";

const mocks = vi.hoisted(() => ({ list: vi.fn(), mutate: vi.fn(), empty: vi.fn(), confirm: vi.fn(), refresh: vi.fn(), workspace: "personal" }));
vi.mock("../trashApi", () => ({ trashApi: { list: mocks.list, mutate: mocks.mutate, empty: mocks.empty } }));
vi.mock("@/lib/api", () => ({ getCurrentWorkspace: () => mocks.workspace }));
vi.mock("@/lib/realtime", () => ({ realtime: { on: () => () => {} } }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { notesRefreshToken: 0, activeNote: null } }), useAppActions: () => ({ refreshNotes: mocks.refresh, refreshNotebooks: mocks.refresh }) }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/workspaceRefreshBridge", () => ({ emitKnowledgeTreeRefresh: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { language: "zh-CN", t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh-CN" }, t: (key: string, values: Record<string, unknown> = {}) => {
  let text = key.split(".").reduce((value: any, part) => value?.[part], zh) || key;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, String(value));
  return text;
} }) }));
import TrashPage from "../TrashPage";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, resourceType: TrashItem["resourceType"], extra: Partial<TrashItem> = {}): TrashItem => ({
  id, resourceId: id, resourceType, title: id, contentFormat: null, deletedAt: "2026-10-04 12:00:00", originalParentId: null,
  originalPath: ["工作", "项目"], originalPathHidden: false, canRestore: true, canDeletePermanently: true, isLocked: false, restoreIncludesAncestors: false, ...extra,
});
describe("independent trash center", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => { await act(async () => { root.render(<TrashPage />); }); };
  const click = async (label: string) => {
    await act(async () => {
      const target = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label || button.textContent === label);
      expect(target).toBeDefined();
      target!.click();
    });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspace = "personal";
    mocks.list.mockResolvedValue({ items: [item("文档", "note"), item("目录", "notebook"), item("脑图A", "mindmap"), item("表格A", "sheet")] });
    mocks.confirm.mockResolvedValue(true);
    mocks.mutate.mockResolvedValue({ succeededIds: ["文档"], noteIds: [], failures: [] });
    mocks.empty.mockResolvedValue({ succeededIds: [], noteIds: [], failures: [] });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("shows mixed types, original location and deletion timestamps and filters sheets separately", async () => {
    await render();
    expect(host.querySelectorAll("li")).toHaveLength(4);
    expect(host.textContent).toContain("工作 / 项目");
    expect(host.textContent).toContain("删除于");
    await click("轻量表格");
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(host.querySelector("li")?.textContent).toContain("表格A");
  });

  it("cancelling irreversible deletion sends no mutation and counts selected descendants", async () => {
    mocks.list.mockResolvedValue({ items: [item("目录", "notebook"), item("子笔记", "note", { originalParentId: "目录" })] });
    mocks.confirm.mockResolvedValue(false);
    await render();
    await click("永久删除 目录");
    expect(mocks.confirm.mock.calls[0][0].description).toContain("2 项");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("restoring a deleted ancestor requests confirmation and sends a scoped request", async () => {
    mocks.list.mockResolvedValue({ items: [item("文档", "note", { restoreIncludesAncestors: true })] });
    await render();
    await click("恢复 文档");
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledWith("personal", "restore", ["文档"]);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("retains protected items and reports partial failures after empty trash", async () => {
    mocks.list.mockResolvedValue({ items: [item("锁定笔记", "note", { isLocked: true, canDeletePermanently: false })] });
    mocks.empty.mockResolvedValue({ succeededIds: [], noteIds: [], failures: [{ id: "锁定笔记", code: "TRASH_DELETE_FORBIDDEN", error: "内容已锁定" }] });
    await render();
    expect((host.querySelector('[aria-label="永久删除 锁定笔记"]') as HTMLButtonElement).disabled).toBe(true);
    await click("清空回收站");
    expect(mocks.empty).toHaveBeenCalledWith("personal");
    expect(host.querySelector('li [role="alert"]')?.textContent).toContain("内容已锁定");
  });

  it("selects visible items and performs batch restore", async () => {
    await render();
    await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(host.textContent).toContain("已选 4 项");
    await click("恢复");
    expect(mocks.mutate).toHaveBeenCalledWith("personal", "restore", ["文档", "目录", "脑图A", "表格A"]);
  });

  it("distinguishes loading failure from an empty trash and offers retry", async () => {
    mocks.list.mockRejectedValueOnce(new Error("网络断开"));
    await render();
    expect(host.textContent).toContain("回收站加载失败");
    expect(host.textContent).not.toContain("回收站是空的");
    await click("重试");
    expect(host.querySelectorAll("li")).toHaveLength(4);
  });

  it("discards a slow old-workspace response when switching spaces", async () => {
    let resolveOld!: (value: { items: TrashItem[] }) => void;
    mocks.list.mockImplementation((workspace: string) => workspace === "personal" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ items: [item("团队文档", "note")] }));
    await render();
    mocks.workspace = "team";
    await render();
    await act(async () => { resolveOld({ items: [item("旧空间", "note")] }); });
    expect(host.textContent).toContain("团队文档");
    expect(host.textContent).not.toContain("旧空间");
  });
});
