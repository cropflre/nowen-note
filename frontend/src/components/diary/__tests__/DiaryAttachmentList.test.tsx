import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { downloadAttachment, toastError } = vi.hoisted(() => ({
  downloadAttachment: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  api: { diaryImages: { urlFor: (id: string) => `http://server.test/api/diary/attachments/${id}` } },
}));
vi.mock("@/lib/downloadFile", () => ({ downloadAttachment }));
vi.mock("@/components/attachmentPreview/AttachmentPreview", () => ({
  default: ({ url, filename }: { url: string; filename: string }) => (
    <div data-testid="attachment-preview" data-url={url}>{filename}</div>
  ),
}));

import DiaryAttachmentList, { type DiaryAttachmentViewItem } from "../DiaryAttachmentList";

const pdf: DiaryAttachmentViewItem = { key: "pdf-1", id: "pdf-1", filename: "合同.pdf", mimeType: "application/pdf", size: 2048 };
const zip: DiaryAttachmentViewItem = { key: "zip-1", id: "zip-1", filename: "资料.zip", mimeType: "application/zip", size: 10 };

describe("DiaryAttachmentList", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    downloadAttachment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  const render = async (element: React.ReactElement) => {
    await act(async () => { root.render(element); });
  };
  const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const click = async (element: HTMLElement | null) => {
    expect(element).toBeTruthy();
    await act(async () => {
      element!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("shows name, size and type, previews PDFs inline, opens, downloads and removes", async () => {
    const onRemove = vi.fn();
    await render(<DiaryAttachmentList items={[pdf]} onRemove={onRemove} />);

    expect(host.textContent).toContain("合同.pdf");
    expect(host.textContent).toContain("2.0 KB · application/pdf");
    const open = byLabel("diary.attachment.open 合同.pdf") as HTMLAnchorElement;
    expect(open.href).toBe("http://server.test/api/diary/attachments/pdf-1");
    expect(open.target).toBe("_blank");

    await click(byLabel("diary.attachment.download 合同.pdf"));
    expect(downloadAttachment).toHaveBeenCalledWith("http://server.test/api/diary/attachments/pdf-1", "合同.pdf");

    await click(byLabel("diary.attachment.preview 合同.pdf"));
    const preview = host.querySelector("[data-testid=attachment-preview]");
    expect(preview?.getAttribute("data-url")).toBe("http://server.test/api/diary/attachments/pdf-1");
    await click(byLabel("diary.attachment.collapse 合同.pdf"));
    expect(host.querySelector("[data-testid=attachment-preview]")).toBeNull();

    await click(byLabel("diary.attachment.remove 合同.pdf"));
    expect(onRemove).toHaveBeenCalledWith(pdf);
  });

  it("offers open and download but no inline preview for archives; download failures are reported", async () => {
    downloadAttachment.mockRejectedValueOnce(new Error("HTTP 404"));
    await render(<DiaryAttachmentList items={[zip]} />);

    expect(byLabel("diary.attachment.preview 资料.zip")).toBeNull();
    expect(byLabel("diary.attachment.open 资料.zip")).toBeTruthy();
    expect(byLabel("diary.attachment.remove 资料.zip")).toBeNull();
    await click(byLabel("diary.attachment.download 资料.zip"));
    expect(toastError).toHaveBeenCalledWith("diary.attachment.downloadFailed");
  });

  it("shows progress while uploading and retry instead of open/download after a failure", async () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const uploading: DiaryAttachmentViewItem = { key: "local-1", id: null, filename: "发票.pdf", mimeType: "application/pdf", size: 1, status: "uploading" };
    const failed: DiaryAttachmentViewItem = { key: "local-2", id: null, filename: "合同.docx", mimeType: "application/msword", size: 1, status: "error", errorMessage: "网络连接中断" };
    const blocked: DiaryAttachmentViewItem = { key: "local-3", id: null, filename: "setup.exe", mimeType: "application/x-msdownload", size: 1, status: "error", errorMessage: "出于安全原因，不支持上传可执行或脚本类文件", retryable: false };
    await render(<DiaryAttachmentList items={[uploading, failed, blocked]} onRemove={onRemove} onRetry={onRetry} />);

    expect(host.textContent).toContain("diary.attachment.uploading");
    expect(byLabel("diary.attachment.remove 发票.pdf")).toBeNull();
    expect(byLabel("diary.attachment.open 发票.pdf")).toBeNull();
    expect(byLabel("diary.attachment.download 发票.pdf")).toBeNull();

    expect(host.textContent).toContain("网络连接中断");
    expect(byLabel("diary.attachment.open 合同.docx")).toBeNull();
    await click(byLabel("diary.attachment.retry 合同.docx"));
    expect(onRetry).toHaveBeenCalledWith(failed);

    expect(host.textContent).toContain("出于安全原因，不支持上传可执行或脚本类文件");
    expect(byLabel("diary.attachment.retry setup.exe")).toBeNull();
    await click(byLabel("diary.attachment.remove setup.exe"));
    expect(onRemove).toHaveBeenCalledWith(blocked);
  });

  it("labels the action as deleting a published attachment in delete mode", async () => {
    const onRemove = vi.fn();
    await render(<DiaryAttachmentList items={[pdf]} onRemove={onRemove} removeMode="delete" />);
    await click(byLabel("diary.attachment.delete 合同.pdf"));
    expect(onRemove).toHaveBeenCalledWith(pdf);
  });

  it("renders nothing without attachments", async () => {
    await render(<DiaryAttachmentList items={[]} />);
    expect(host.innerHTML).toBe("");
  });
});
