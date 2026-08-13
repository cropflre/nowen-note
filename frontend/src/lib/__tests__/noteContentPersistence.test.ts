// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

import {
  registerOfflineAttachmentBlob,
  resetAttachmentAccessStateForTests,
} from "@/lib/noteAttachmentAccessBridge";
import {
  stabilizeNoteContentForPersistence,
  TransientNoteImageSourceError,
} from "@/lib/noteContentPersistence";

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

function tiptapImage(src: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "image", attrs: { src, alt: "image" } }],
  });
}

describe("noteContentPersistence", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:https://notes.example.com/default"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    resetAttachmentAccessStateForTests();
  });

  it("stores a stable attachment identity instead of a signed access URL", () => {
    const signed = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=temporary&scope=user`;
    const result = stabilizeNoteContentForPersistence(tiptapImage(signed), "tiptap-json");

    expect(JSON.parse(result).content[0].attrs.src).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    expect(result).not.toContain("sig=");
  });

  it("recovers a known runtime blob URL to its attachment identity", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://notes.example.com/offline-a");
    const objectUrl = registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["image"]))!;

    const result = stabilizeNoteContentForPersistence(tiptapImage(objectUrl), "tiptap-json");

    expect(JSON.parse(result).content[0].attrs.src).toBe(`/api/attachments/${ATTACHMENT_ID}`);
  });

  it("refuses an unknown blob image without deleting the image node", () => {
    const content = tiptapImage("blob:file:///unknown-render-handle");

    expect(() => stabilizeNoteContentForPersistence(content, "tiptap-json"))
      .toThrow(TransientNoteImageSourceError);
    expect(content).toContain('"type":"image"');
  });

  it("does not reject ordinary text that merely mentions a blob URL", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "diagnostic blob:file:///example" }],
      }],
    });

    expect(stabilizeNoteContentForPersistence(content, "tiptap-json")).toBe(content);
  });

  it("normalizes Markdown attachment images and rejects unknown blob images", () => {
    const signed = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?exp=1&sig=temporary`;
    expect(stabilizeNoteContentForPersistence(`![image](${signed})`, "markdown"))
      .toBe(`![image](/api/attachments/${ATTACHMENT_ID})`);
    expect(() => stabilizeNoteContentForPersistence("![image](blob:file:///unknown)", "markdown"))
      .toThrow(TransientNoteImageSourceError);
  });
});
