// @vitest-environment jsdom

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  TASK_ARCHIVE_FORMAT,
  TASK_ARCHIVE_VERSION,
  extractTaskAttachmentReferences,
  parseTaskTransferFile,
  replaceTaskAttachmentReference,
} from "@/lib/taskDataTransferArchive";
import {
  TASK_BACKUP_FORMAT,
  TASK_BACKUP_VERSION,
  type TaskBackupPackage,
} from "@/lib/taskDataTransfer";

function backup(): TaskBackupPackage {
  return {
    format: TASK_BACKUP_FORMAT,
    version: TASK_BACKUP_VERSION,
    exportedAt: "2026-07-11T00:00:00.000Z",
    source: { workspace: "personal", app: "nowen-note" },
    data: {
      projects: [],
      tasks: [{
        sourceId: "task-1",
        title: "检查截图 ![screen.png](/api/task-attachments/image-1)",
        description: "详情",
        isCompleted: 0,
        priority: 2,
        dueDate: null,
        dueAt: null,
        startDate: null,
        noteId: null,
        parentSourceId: null,
        projectSourceId: null,
        sortOrder: 0,
        status: "todo",
        repeatRule: "none",
        repeatInterval: 1,
        repeatEndDate: null,
        repeatEndCount: null,
        repeatGroupId: null,
        repeatGeneratedFromSourceId: null,
        repeatRuleJson: null,
      }],
      dependencies: [],
      reminders: [],
    },
  };
}

async function archiveFile(path = "images/task-1/screen.png"): Promise<File> {
  const pkg = backup();
  const bytes = new TextEncoder().encode("image-bytes");
  const zip = new JSZip();
  zip.file(path, "image-bytes");
  zip.file("tasks.json", JSON.stringify({
    format: TASK_ARCHIVE_FORMAT,
    version: TASK_ARCHIVE_VERSION,
    exportedAt: "2026-07-11T00:00:00.000Z",
    backup: pkg,
    attachments: [{
      sourceAttachmentId: "image-1",
      taskSourceId: "task-1",
      originalUrl: "/api/task-attachments/image-1",
      filename: "screen.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      path,
    }],
  }));
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "nowen-tasks-full.zip", { type: "application/zip" });
}

describe("taskDataTransferArchive", () => {
  it("extracts local task images from title and description without duplicating the same reference", () => {
    const refs = extractTaskAttachmentReferences([{
      sourceId: "task-1",
      title: "A ![one.png](/api/task-attachments/image-1)",
      description: "B ![again](/api/task-attachments/image-1) ![remote](https://example.com/a.png)",
    }]);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      taskSourceId: "task-1",
      sourceAttachmentId: "image-1",
      originalUrl: "/api/task-attachments/image-1",
    });
  });

  it("rewrites both relative and absolute source attachment URLs", () => {
    const attachment = {
      sourceAttachmentId: "image-1",
      originalUrl: "/api/task-attachments/image-1",
    };
    expect(replaceTaskAttachmentReference(
      "![a](/api/task-attachments/image-1)",
      attachment,
      "/api/task-attachments/new-image",
    )).toEqual({
      value: "![a](/api/task-attachments/new-image)",
      changed: true,
    });
    expect(replaceTaskAttachmentReference(
      "![a](https://old.example.com/api/task-attachments/image-1)",
      attachment,
      "/api/task-attachments/new-image",
    ).value).toBe("![a](https://old.example.com/api/task-attachments/new-image)");
  });

  it("parses a full ZIP backup and reports included images", async () => {
    const preview = await parseTaskTransferFile(await archiveFile());
    expect(preview.format).toBe("zip");
    if (preview.format !== "zip") throw new Error("expected zip preview");
    expect(preview.tasks).toBe(1);
    expect(preview.attachments).toBe(1);
    expect(preview.attachmentBytes).toBe(new TextEncoder().encode("image-bytes").byteLength);
    expect(preview.warnings.some((warning) => warning.includes("恢复 1 张任务图片"))).toBe(true);
  });

  it("rejects unsafe image paths before importing", async () => {
    await expect(parseTaskTransferFile(await archiveFile("../screen.png"))).rejects.toThrow("路径不安全");
  });
});
