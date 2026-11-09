import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { downloadDocxBlob } from "@/lib/wordNoteService";
import * as nativeSave from "@/lib/nativeImageSave";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadDocxBlob", () => {
  it("saves on Harmony through the system picker and reports cancellation", async () => {
    vi.spyOn(nativeSave, "isHarmonyNative").mockReturnValue(true);
    const save = vi.spyOn(nativeSave, "saveBlobToSystemFile").mockResolvedValueOnce({ success: true, uri: "file://saved" }).mockResolvedValueOnce({ success: false, uri: "", canceled: true });
    const stage = vi.spyOn(api, "stageGeneratedExport");
    const blob = new Blob(["docx"]);
    await downloadDocxBlob(blob, "测试");
    expect(save).toHaveBeenCalledWith({ blob, fileName: "测试.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(stage).not.toHaveBeenCalled();
    await expect(downloadDocxBlob(blob, "测试")).rejects.toThrow("已取消保存");
  });
  it("stages DOCX on the server before triggering a real HTTP download", async () => {
    const blob = new Blob(["docx"], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const stage = vi.spyOn(api, "stageGeneratedExport").mockResolvedValue({
      downloadToken: "docx-token",
      filename: "资料分析模块.docx",
      size: 4,
    });
    const download = vi.spyOn(api, "downloadMarkdownExport").mockImplementation(() => {});

    await downloadDocxBlob(blob, "资料分析模块");

    expect(stage).toHaveBeenCalledWith(blob, "资料分析模块.docx");
    expect(download).toHaveBeenCalledWith("docx-token", "资料分析模块.docx");
  });
});
