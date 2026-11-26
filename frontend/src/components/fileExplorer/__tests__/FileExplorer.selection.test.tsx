// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileExplorer from "../FileExplorer";
import type { FileItem } from "@/types";

const state = vi.hoisted(() => ({
  filesList: vi.fn(),
  foldersList: vi.fn(),
  stats: vi.fn(),
  batchRemove: vi.fn(),
  confirm: vi.fn(),
  createShare: vi.fn(),
  copyText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  detailOpens: [] as string[],
}));

vi.mock("@/lib/aiConnection", () => ({ useAIConnectionAvailable: () => false }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init() {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params?.count !== undefined) return `${key}:${params.count}`;
      if (params?.name !== undefined) return `${key}:${params.name}`;
      return key;
    },
  }),
}));
vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => "personal",
  getServerUrl: () => "http://qa.local",
  getBaseUrl: () => "/api",
  resolveAttachmentUrl: (url: string) => url,
  api: {
    getMe: async () => ({ role: "user" }),
    files: {
      organization: { list: async () => ({ supported: false, canManageTags: false, tags: [], smartFolders: [] }) },
      list: state.filesList,
      stats: state.stats,
      batchRemove: state.batchRemove,
    },
    attachmentFolders: { list: state.foldersList },
    dataFile: { cleanupOrphans: async () => ({ totalRemovedItems: 0, totalFreedBytes: 0, diskScanSkipped: true, graceHours: 24 }) },
  },
}));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => "qa-account" }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({}) }));
vi.mock("@/components/ui/confirm", () => ({ confirm: state.confirm, prompt: vi.fn() }));
vi.mock("@/hooks/useFileUploadQueue", () => ({ useFileUploadQueue: () => ({ tasks: [], enqueue: vi.fn() }) }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({
  default: ({ attachmentId }: { attachmentId: string }) => {
    state.detailOpens.push(attachmentId);
    return null;
  },
}));
vi.mock("@/components/FileMoveDialog", () => ({ default: () => null }));
vi.mock("@/lib/downloadFile", () => ({ downloadAttachment: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: state.copyText }));
vi.mock("@/lib/fileShareClipboard", () => ({ createStableFileShareUrl: state.createShare }));
vi.mock("@/lib/toast", () => ({ toast: { error: state.toastError, success: state.toastSuccess } }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: { filePublicOrigin: "", filePublicOriginSource: "inherit", publicWebOrigin: "" }, updateFilePublicOrigin: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItems(count: number): FileItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `file-${index}`,
    filename: `photo-${index}.png`,
    category: "image",
    mimeType: "image/png",
    size: 128,
    url: `/api/attachments/file-${index}`,
    hash: null,
    createdAt: "2026-11-26",
    folderId: null,
    folderName: null,
    primaryNote: null,
    externalAccessEnabled: index !== 2,
    publicLinkActive: false,
    canManage: true,
  }));
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.detailOpens = [];
  const sample = makeItems(3);
  state.filesList.mockImplementation(async ({ page = 1, pageSize = 60 }: { page?: number; pageSize?: number } = {}) => ({
    items: sample.slice((page - 1) * pageSize, page * pageSize),
    total: sample.length,
  }));
  state.foldersList.mockResolvedValue({ folders: [] });
  state.stats.mockResolvedValue({
    total: 3, totalBytes: 384, images: { count: 3, bytes: 384 }, files: { count: 0, bytes: 0 },
    unreferenced: { count: 0, bytes: 0 }, myUploads: { total: 3, referenced: 0, unreferenced: 3 }, byMime: [],
  });
  state.batchRemove.mockImplementation(async (ids: string[]) => ({ success: true, deleted: ids.length, failed: [] }));
  state.confirm.mockResolvedValue(true);
  state.createShare.mockImplementation(async (id: string) => `https://files.example/api/f/${id}.png`);
  state.copyText.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
});

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text);

it("supports card checkboxes, immediate select-all/deselect-page, and list header select-all", async () => {
  await act(async () => root.render(<FileExplorer />));

  // Direct checkbox toggle selects without opening detail drawer.
  const firstBox = host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="fileExplorer.selectFileItem:photo-0.png"]')!;
  await act(async () => firstBox.click());
  expect(state.detailOpens).toEqual([]);
  expect(host.textContent).toContain("fileExplorer.selected:1");

  // Select all page works right from the toolbar, then switches to deselectPage.
  await act(async () => button("fileExplorer.selectAllPage")!.click());
  expect(host.textContent).toContain("fileExplorer.selected:3");
  expect(button("fileExplorer.deselectPage")).toBeDefined();

  // Switching to list view preserves selection and exposes the column header select-all checkbox.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="fileExplorer.views.list"]')!.click());
  const headerBox = host.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="fileExplorer.deselectPage"]')!;
  expect(headerBox.checked).toBe(true);
  await act(async () => headerBox.click());
  expect(host.textContent).not.toContain("fileExplorer.selected:");
});

it("selects all matching files across pages and chunks batch deletion by 200", async () => {
  const all250 = makeItems(250);
  state.filesList.mockImplementation(async ({ page = 1, pageSize = 60 }: { page?: number; pageSize?: number } = {}) => ({
    items: all250.slice((page - 1) * pageSize, page * pageSize),
    total: all250.length,
  }));

  await act(async () => root.render(<FileExplorer />));
  await act(async () => button("fileExplorer.selectAllPage")!.click());
  expect(host.textContent).toContain("fileExplorer.selected:60");

  await act(async () => button("fileExplorer.selectAllMatching:250")!.click());
  expect(host.textContent).toContain("fileExplorer.selected:250");

  await act(async () => button("assetTrash.move")!.click());
  expect(state.confirm).toHaveBeenCalledTimes(1);
  expect(state.batchRemove).toHaveBeenCalledTimes(2);
  expect(state.batchRemove.mock.calls[0][0]).toHaveLength(200);
  expect(state.batchRemove.mock.calls[1][0]).toHaveLength(50);
});

it("supports multi-select, select-all, batch public link copy, and batch recycle in Image hosting view", async () => {
  await act(async () => root.render(<FileExplorer />));
  await act(async () => host.querySelector<HTMLButtonElement>("#file-page-tab-imageHost")!.click());

  const hostPanel = host.querySelector("#file-page-panel-imageHost")!;
  const selectAllBtn = [...hostPanel.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "fileExplorer.selectAllPage")!;
  await act(async () => selectAllBtn.click());
  expect(hostPanel.textContent).toContain("fileExplorer.selected:3");

  // file-2 has externalAccessEnabled=false, so batch copy skips it cleanly.
  const copyBtn = [...hostPanel.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "fileExplorer.batchCopyLinks")!;
  await act(async () => copyBtn.click());
  expect(state.copyText).toHaveBeenCalledWith("https://files.example/api/f/file-0.png\nhttps://files.example/api/f/file-1.png");
  expect(state.toastSuccess).toHaveBeenCalledWith("fileExplorer.batchLinksCopiedPartial:2");

  const trashBtn = [...hostPanel.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "assetTrash.move")!;
  await act(async () => trashBtn.click());
  expect(state.batchRemove).toHaveBeenCalledWith(["file-0", "file-1", "file-2"]);
});
