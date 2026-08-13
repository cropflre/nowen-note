import { describe, expect, it } from "vitest";

import {
  decideAttachmentPrimaryAction,
  detectAttachmentPreviewKind,
} from "@/lib/attachmentOpenStrategy";

describe("附件主操作策略", () => {
  it.each(["xlsx", "xls", "xlsm", "ods", "ppt", "pptx", "pptm", "odp"])(
    "%s 使用系统默认程序打开",
    (extension) => {
      expect(decideAttachmentPrimaryAction("application/octet-stream", `季度报表.${extension}`))
        .toBe("desktop-default");
    },
  );

  it("文件名缺少扩展名时仍可按 Office MIME 识别", () => {
    expect(decideAttachmentPrimaryAction(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "季度报表",
    )).toBe("desktop-default");
  });

  it.each([
    ["application/pdf", "报告.bin", "pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "报告.bin", "docx"],
    ["image/png", "图片.bin", "image"],
    ["text/plain", "说明.bin", "text"],
    ["application/octet-stream", "演示.mp4", "video"],
  ])("%s / %s 保持现有 %s 预览", (mimeType, filename, kind) => {
    expect(detectAttachmentPreviewKind(mimeType, filename)).toBe(kind);
    expect(decideAttachmentPrimaryAction(mimeType, filename)).toBe("preview");
  });

  it("未知二进制文件进入详情和下载 fallback", () => {
    expect(decideAttachmentPrimaryAction("application/octet-stream", "archive.unknown"))
      .toBe("details");
  });
});
