import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import FileMoveDialog from "../FileMoveDialog";
import AttachmentDetailDrawer from "../attachmentDetail/AttachmentDetailDrawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), move: vi.fn(), get: vi.fn(), access: vi.fn(), copied: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { attachmentFolders: { list: mocks.list }, files: { move: mocks.move, get: mocks.get, setExternalAccess: mocks.access } },
  resolveAttachmentUrl: (url: string) => `http://localhost${url}`,
}));
vi.mock("@/hooks/useSiteSettings", () => ({ useSiteSettings: () => ({ siteConfig: {} }) }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copied }));
vi.mock("@/components/attachmentPreview/AttachmentPreview", () => ({ default: () => <div>Preview</div> }));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const detail = { id: "file-1", filename: "中文文件.pdf", mimeType: "application/pdf", size: 5, createdAt: "2026-10-14T00:00:00Z",
  category: "file", url: "/api/attachments/file-1", folderId: "a", folderName: "目录甲", references: [], primaryNote: null,
  canManage: true, externalAccessEnabled: true };
const translate = (key: string) => key;
// Keep useTranslation's function identity stable, as it is in the app.
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

describe("file organization controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ folders: [{ id: "a", name: "目录甲" }, { id: "b", name: "目录乙" }] });
    mocks.move.mockResolvedValue({ moved: 1, folderId: "b", folderName: "目录乙" });
    mocks.get.mockResolvedValue(detail);
    mocks.access.mockResolvedValue({ externalAccessEnabled: false });
    vi.stubGlobal("matchMedia", vi.fn((media: string): MediaQueryList => ({
      matches: false, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
    })));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
  }

  it("moves selected files to a chosen folder only after the API succeeds", async () => {
    const onMoved = vi.fn(); const onClose = vi.fn();
    await act(async () => { root.render(<FileMoveDialog ids={["file-1"]} currentFolderId="a" onMoved={onMoved} onClose={onClose} />); });
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("fileManager.moveFiles");
    expect(mocks.move).toHaveBeenCalledWith(["file-1"], "b");
    expect(onMoved).toHaveBeenCalledWith("b", "目录乙"); expect(onClose).toHaveBeenCalledOnce();
  });

  it("retains the dialog and selection when moving fails", async () => {
    mocks.move.mockRejectedValue(new Error("No access")); const onMoved = vi.fn(); const onClose = vi.fn();
    await act(async () => { root.render(<FileMoveDialog ids={["file-1"]} onMoved={onMoved} onClose={onClose} />); });
    await click("fileManager.moveFiles");
    expect(mocks.error).toHaveBeenCalledWith("No access"); expect(onMoved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it("does not allow a move when folder loading fails", async () => {
    mocks.list.mockRejectedValue(new Error("Offline"));
    await act(async () => { root.render(<FileMoveDialog ids={["file-1"]} onMoved={vi.fn()} onClose={vi.fn()} />); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Offline");
    await click("fileManager.moveFiles"); expect(mocks.move).not.toHaveBeenCalled();
  });

  it("turns off external access without removing the preview or owner download", async () => {
    await act(async () => { root.render(<AttachmentDetailDrawer attachmentId="file-1" onClose={vi.fn()} />); });
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await act(async () => { checkbox.click(); });
    expect(mocks.access).toHaveBeenCalledWith("file-1", false);
    expect(checkbox.checked).toBe(false);
    expect(container.textContent).toContain("fileManager.externalDisabled");
    expect(container.textContent).toContain("Preview");
    expect(container.textContent).toContain("attachmentDetail.downloadFile");
    expect(container.textContent).not.toContain("attachmentDetail.copyFormat");
  });

  it("retains the last confirmed access state on API failure", async () => {
    mocks.access.mockRejectedValue(new Error("Offline"));
    await act(async () => { root.render(<AttachmentDetailDrawer attachmentId="file-1" onClose={vi.fn()} />); });
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); });
    expect(checkbox.checked).toBe(true); expect(mocks.error).toHaveBeenCalledWith("Offline");
  });

  it("hides management controls for read-only files", async () => {
    mocks.get.mockResolvedValue({ ...detail, canManage: false });
    await act(async () => { root.render(<AttachmentDetailDrawer attachmentId="file-1" onClose={vi.fn()} />); });
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("fileManager.moveFiles");
  });

  it("ignores an old file's privacy response after switching to another file", async () => {
    let complete!: (value: { externalAccessEnabled: boolean }) => void;
    mocks.access.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const onClose = vi.fn();
    await act(async () => { root.render(<AttachmentDetailDrawer attachmentId="file-1" onClose={onClose} />); });
    await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    mocks.get.mockResolvedValue({ ...detail, id: "file-2" });
    await act(async () => { root.render(<AttachmentDetailDrawer attachmentId="file-2" onClose={onClose} />); });
    await act(async () => { complete({ externalAccessEnabled: false }); });
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });
});
