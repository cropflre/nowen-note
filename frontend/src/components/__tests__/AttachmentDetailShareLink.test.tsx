import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentDetailDrawer from "../attachmentDetail/AttachmentDetailDrawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ get: vi.fn(), access: vi.fn(), share: vi.fn(), copy: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { files: { get: mocks.get, setExternalAccess: mocks.access } },
  getCurrentWorkspace: () => "personal",
  // The runtime URL the app uses for previews: signed and expiring.
  resolveAttachmentUrl: (url: string) => `http://localhost${url}?exp=1&sig=runtime&scope=v2.user`,
}));
vi.mock("@/lib/fileShareClipboard", () => ({ createStableFileShareUrl: mocks.share }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/attachmentPreview/AttachmentPreview", () => ({ default: () => <div>Preview</div> }));
vi.mock("@/components/fileExplorer/AssetTagEditor", () => ({ default: () => null }));
vi.mock("@/components/fileExplorer/AssetDescription", () => ({ default: () => null }));
vi.mock("@/components/PluginInspector", () => ({ default: () => null }));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const translate = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

const stable = "https://files.example/api/f/opaque-token.png";
const detail = { id: "file-1", filename: "截图.png", mimeType: "image/png", size: 5, createdAt: "2026-11-19T00:00:00Z",
  category: "image", url: "/api/attachments/file-1", folderId: null, folderName: null, references: [], primaryNote: null,
  canManage: true, externalAccessEnabled: true };

describe("attachment detail public link", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onAfterLinkChange = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(detail);
    mocks.access.mockResolvedValue({ externalAccessEnabled: false });
    mocks.share.mockResolvedValue(stable);
    mocks.copy.mockResolvedValue(true);
    vi.stubGlobal("matchMedia", vi.fn((media: string): MediaQueryList => ({
      matches: false, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
    })));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  async function render() {
    await act(async () => { root.render(<AttachmentDetailDrawer attachmentId="file-1" onClose={vi.fn()} onAfterLinkChange={onAfterLinkChange} />); });
  }
  const copyButtons = () => [...container.querySelectorAll("button")].filter((button) => button.textContent === "attachmentDetail.copyFormat");
  const linkBox = () => container.querySelector<HTMLInputElement>('input[aria-label="attachmentDetail.shareLink"]');

  it("never shows the expiring runtime URL before a public link exists", async () => {
    await render();
    expect(linkBox()).toBeNull();
    expect([...container.querySelectorAll("input")].some((input) => input.value.includes("sig=runtime"))).toBe(false);
    expect(container.textContent).toContain("attachmentDetail.publicLinkHint");
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("copies the server-issued link and then shows it for manual copying", async () => {
    await render();
    await act(async () => { copyButtons()[0].click(); });
    expect(mocks.share).toHaveBeenCalledWith("file-1");
    expect(mocks.copy).toHaveBeenLastCalledWith(stable);
    expect(linkBox()!.value).toBe(stable);
    expect(onAfterLinkChange).toHaveBeenCalledWith("file-1");
    await act(async () => { copyButtons()[1].click(); });
    expect(mocks.copy).toHaveBeenLastCalledWith(`![截图.png](${stable})`);
  });

  it("copies nothing when the server refuses a public link", async () => {
    mocks.share.mockRejectedValue(new Error("此文件已关闭公开外链"));
    await render();
    await act(async () => { copyButtons()[0].click(); });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("此文件已关闭公开外链");
    expect(linkBox()).toBeNull();
    expect(onAfterLinkChange).not.toHaveBeenCalled();
  });

  it("drops the shown link when external access is turned off", async () => {
    await render();
    await act(async () => { copyButtons()[0].click(); });
    expect(linkBox()!.value).toBe(stable);
    await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    expect(linkBox()).toBeNull();
    expect(container.textContent).toContain("fileManager.externalDisabled");
  });
});
