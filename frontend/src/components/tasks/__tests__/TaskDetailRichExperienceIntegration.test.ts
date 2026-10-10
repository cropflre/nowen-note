import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const taskCenterSource = readFileSync(path.resolve(__dirname, "../../TaskCenter.tsx"), "utf8");
const bridgeSource = readFileSync(path.resolve(__dirname, "../TaskDetailRichExperienceBridge.tsx"), "utf8");
const editorSource = readFileSync(path.resolve(__dirname, "../TaskDescriptionRichEditor.tsx"), "utf8");
const attachmentsSource = readFileSync(path.resolve(__dirname, "../TaskAttachmentSection.tsx"), "utf8");

describe("rich task detail integration", () => {
  it("mounts the rich task detail experience from the task center shell", () => {
    expect(taskCenterSource).toContain(
      'import TaskDetailRichExperienceBridge from "./tasks/TaskDetailRichExperienceBridge"',
    );
    expect(taskCenterSource).toContain("<TaskDetailRichExperienceBridge />");
  });

  it("uses the rich editor and independent task attachment surface", () => {
    expect(bridgeSource).toContain("<TaskDescriptionRichEditor");
    expect(bridgeSource).toContain("<TaskAttachmentSection");
    expect(editorSource).toContain("useEditor({");
    expect(editorSource).toContain("insertTable");
    expect(editorSource).toContain("uploadTaskAttachment");
    expect(attachmentsSource).toContain("listTaskAttachments");
    expect(attachmentsSource).toContain("taskAttachmentUrl");
  });

  it("keeps generic attachment previews independent from note attachments", () => {
    expect(attachmentsSource).toContain('kind === "pdf"');
    expect(attachmentsSource).toContain('kind === "video"');
    expect(attachmentsSource).toContain('kind === "audio"');
    expect(attachmentsSource).toContain('type="file"');
    expect(attachmentsSource).not.toContain("/api/attachments/");
  });
});
