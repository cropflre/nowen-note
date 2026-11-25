import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileExplorer from "../FileExplorer";
import { imageHostListParams, publicLinkStatus } from "@/lib/filePageViews";
import { consumeMobileBack } from "@/lib/mobileBackNavigation";

const state = vi.hoisted(() => ({
  filesList: vi.fn(), foldersList: vi.fn(), stats: vi.fn(), cleanup: vi.fn(), getMe: vi.fn(),
  createShare: vi.fn(), copyText: vi.fn(), setExternalAccess: vi.fn(), enqueue: vi.fn(),
  drawerProps: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/aiConnection", () => ({ useAIConnectionAvailable: () => false }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init() {} },
  useTranslation: () => ({ t: (key: string, options?: { format?: string }) => options?.format ? `${key}:${options.format}` : key }),
}));
vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => "personal", getServerUrl: () => "http://qa.local", getBaseUrl: () => "/api",
  resolveAttachmentUrl: (url: string) => url,
  api: {
    getMe: state.getMe,
    files: {
      organization: { list: async () => ({ supported: false, canManageTags: false, tags: [], smartFolders: [] }) },
      list: state.filesList, stats: state.stats, setExternalAccess: state.setExternalAccess, batchRemove: vi.fn(),
    },
    attachmentFolders: { list: state.foldersList },
    dataFile: { cleanupOrphans: state.cleanup },
  },
}));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => "qa-account" }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({}) }));
vi.mock("@/components/ui/confirm", () => ({ confirm: vi.fn(), prompt: vi.fn() }));
vi.mock("@/hooks/useFileUploadQueue", () => ({ useFileUploadQueue: () => ({ tasks: [], enqueue: state.enqueue }) }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({
  default: (props: Record<string, unknown>) => { state.drawerProps.push(props); return null; },
}));
vi.mock("@/components/FileMoveDialog", () => ({ default: () => null }));
vi.mock("@/lib/downloadFile", () => ({ downloadAttachment: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: state.copyText }));
vi.mock("@/lib/fileShareClipboard", () => ({ createStableFileShareUrl: state.createShare }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: { filePublicOrigin: "", filePublicOriginSource: "inherit", publicWebOrigin: "" }, updateFilePublicOrigin: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const shareUrl = "https://files.example/api/f/opaque-token.png";
const files = [
  { id: "public-a", filename: "public.png", category: "image", mimeType: "image/png", size: 10, url: "/api/attachments/public-a",
    createdAt: "2026-11-01", folderId: null, externalAccessEnabled: true, publicLinkActive: true },
  { id: "private-b", filename: "截图 [原图].png", category: "image", mimeType: "image/png", size: 20, url: "/api/attachments/private-b",
    createdAt: "2026-11-02", folderId: null, externalAccessEnabled: true, publicLinkActive: false },
  { id: "off-c", filename: "report.pdf", category: "file", mimeType: "application/pdf", size: 30, url: "/api/attachments/off-c",
    createdAt: "2026-11-03", folderId: null, externalAccessEnabled: false, publicLinkActive: false },
];
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks(); state.drawerProps = [];
  state.filesList.mockImplementation(async () => ({ items: files.map((file) => ({ ...file })), total: files.length }));
  state.foldersList.mockResolvedValue({ folders: [{ id: "folder-a", name: "Folder A", parentId: null, fileCount: 0 }] });
  state.stats.mockResolvedValue({ total: 3, totalBytes: 60, images: { count: 2, bytes: 30 }, files: { count: 1, bytes: 30 }, unreferenced: { count: 0, bytes: 0 }, myUploads: { total: 3, referenced: 0, unreferenced: 3 }, byMime: [] });
  state.cleanup.mockResolvedValue({ totalRemovedItems: 0, totalFreedBytes: 0, diskScanSkipped: true, graceHours: 24 });
  state.getMe.mockResolvedValue({ role: "user" });
  state.createShare.mockResolvedValue(shareUrl);
  state.copyText.mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); });

const tab = (view: string) => host.querySelector<HTMLButtonElement>(`#file-page-tab-${view}`)!;
const byText = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
async function openView(view: string) { await act(async () => tab(view).click()); }
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("replaces the separate tools page with three in-page views", async () => {
  await act(async () => root.render(<FileExplorer />));
  expect([...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent))
    .toEqual(["fileExplorer.pageViews.files", "fileExplorer.pageViews.imageHost", "fileExplorer.pageViews.storage"]);
  expect(tab("files").getAttribute("aria-selected")).toBe("true");
  expect(byText("fileExplorer.storageTools")).toBeUndefined();
  await act(async () => tab("files").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(tab("imageHost").getAttribute("aria-selected")).toBe("true");
});

it("returns to the same folder, search and scroll position after visiting other views", async () => {
  await act(async () => root.render(<FileExplorer />));
  await act(async () => byText("Folder A")!.click());
  const search = host.querySelector<HTMLInputElement>('input[aria-label="fileExplorer.search"]')!;
  await act(async () => type(search, "logo"));
  const scroller = host.querySelector("#file-page-panel-files")!.firstElementChild as HTMLDivElement;
  Object.defineProperty(scroller, "scrollTop", { value: 480, writable: true, configurable: true });

  await openView("imageHost");
  expect(host.querySelector("#file-page-panel-files")!.className).toContain("hidden");
  expect(host.querySelector('input[aria-label="fileExplorer.search"]')).toBeNull();
  scroller.scrollTop = 0; // Browsers may drop the offset of a hidden scroller.
  await openView("storage");
  await openView("files");

  expect(host.querySelector<HTMLInputElement>('input[aria-label="fileExplorer.search"]')!.value).toBe("logo");
  expect(host.querySelector("h1")!.textContent).toBe("Folder A");
  expect(scroller.scrollTop).toBe(480);
});

it("shows link status without creating links or changing access on entry", async () => {
  await act(async () => root.render(<FileExplorer />));
  await openView("imageHost");
  await openView("files");
  await openView("imageHost");
  const statuses = [...host.querySelectorAll("[data-link-status]")].map((node) => node.getAttribute("data-link-status"));
  expect(statuses).toEqual(["public", "private", "disabled"]);
  expect(state.createShare).not.toHaveBeenCalled();
  expect(state.copyText).not.toHaveBeenCalled();
  expect(state.setExternalAccess).not.toHaveBeenCalled();
  const hostCalls = state.filesList.mock.calls.map(([params]) => params).filter((params) => !("folderId" in params) && "q" in params);
  expect(hostCalls.length).toBeGreaterThan(0);
  for (const params of hostCalls) expect(Object.keys(params).sort()).toEqual(["page", "pageSize", "q", "sort"]);

  const disabledCard = host.querySelector('#file-page-panel-imageHost [aria-label="report.pdf"]')!;
  expect([...disabledCard.querySelectorAll("button")].find((button) => button.textContent === "fileExplorer.imageHost.copyLink")!.disabled).toBe(true);
});

it("copies URL, Markdown and HTML from the server-issued link and marks the file public", async () => {
  await act(async () => root.render(<FileExplorer />));
  await openView("imageHost");
  const card = () => host.querySelector('#file-page-panel-imageHost [aria-label="截图 [原图].png"]')!;
  await act(async () => [...card().querySelectorAll("button")].find((button) => button.textContent === "fileExplorer.imageHost.copyLink")!.click());
  expect(state.createShare).toHaveBeenCalledWith("private-b");
  expect(state.copyText).toHaveBeenLastCalledWith(shareUrl);
  expect(card().querySelector("[data-link-status]")!.getAttribute("data-link-status")).toBe("public");

  for (const [format, expected] of [
    ["Markdown", String.raw`![截图 \[原图\].png](${shareUrl})`],
    ["HTML", `<img src="${shareUrl}" alt="截图 [原图].png" />`],
  ] as const) {
    await act(async () => card().querySelector<HTMLButtonElement>('[aria-label="fileExplorer.imageHost.copyFormats"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === `attachmentDetail.copyFormat:${format}`)!.click());
    expect(state.copyText).toHaveBeenLastCalledWith(expected);
  }
});

it("opens file details with the link section and uploads Image hosting files to the root", async () => {
  await act(async () => root.render(<FileExplorer />));
  await act(async () => byText("Folder A")!.click());
  const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const upload = new File(["x"], "shot.png", { type: "image/png" });
  Object.defineProperty(picker, "files", { value: [upload], configurable: true });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(state.enqueue).toHaveBeenLastCalledWith([upload], "folder-a");

  await openView("imageHost");
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(state.enqueue).toHaveBeenLastCalledWith([upload], null);

  await act(async () => host.querySelector<HTMLElement>('#file-page-panel-imageHost [aria-label="public.png"]')!.click());
  const drawer = state.drawerProps.at(-1)!;
  expect(drawer.attachmentId).toBe("public-a");
  expect(drawer.isImageHostMode).toBe(true);
  expect(typeof drawer.onAfterLinkChange).toBe("function");
});

it("returns to Files from the sidebar or the Android back button", async () => {
  await act(async () => root.render(<FileExplorer />));
  await openView("storage");
  await act(async () => { expect(consumeMobileBack()).toBe(true); });
  expect(tab("files").getAttribute("aria-selected")).toBe("true");

  await openView("imageHost");
  await act(async () => byText("fileExplorer.image")!.click());
  expect(tab("files").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("h1")!.textContent).toBe("fileExplorer.image");
});

it("maps the former image-host tabs to plain list filters", () => {
  expect(imageHostListParams("all", "", "created_desc", 1)).toEqual({ q: undefined, sort: "created_desc", page: 1, pageSize: 60 });
  expect(imageHostListParams("image", "logo", "name_asc", 2)).toMatchObject({ category: "image", q: "logo", page: 2 });
  expect(imageHostListParams("file", "", "created_desc", 1)).toMatchObject({ category: "file" });
  expect(imageHostListParams("myUploads", "", "created_desc", 1)).toMatchObject({ filter: "myUploads" });
  expect(imageHostListParams("unreferenced", "", "created_desc", 1)).toMatchObject({ filter: "unreferenced" });
  expect(publicLinkStatus({})).toBe("unknown");
  expect(publicLinkStatus({ externalAccessEnabled: false, publicLinkActive: true })).toBe("disabled");
});
