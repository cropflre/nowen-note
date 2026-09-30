// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

import {
  registerOfflineAttachmentBlob,
  registerNativeAttachmentUrl,
  resetAttachmentAccessStateForTests,
} from "@/lib/noteAttachmentAccessBridge";
import {
  stabilizeNoteContentForPersistence,
  TransientNoteImageSourceError,
  TransientNoteAudioSourceError,
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

  function voice(src: string, attachmentId?: string) {
    return JSON.stringify({ type: "doc", content: [{ type: "voiceMemo", attrs: { src, attachmentId, filename: "语音.webm" } }] });
  }
  it("canonicalizes registered native and offline audio without an explicit ID", () => {
    const native = "https://localhost/_capacitor_file_/data/user/0/voice.webm";
    registerNativeAttachmentUrl(ATTACHMENT_ID, native);
    const blob = registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["audio"]))!;
    for (const src of [native, blob]) {
      const attrs = JSON.parse(stabilizeNoteContentForPersistence(voice(src), "tiptap-json")).content[0].attrs;
      expect(attrs).toMatchObject({ src: `/api/attachments/${ATTACHMENT_ID}`, attachmentId: ATTACHMENT_ID });
    }
  });
  it.each(["capacitor://localhost/old.webm", "https://localhost/_capacitor_file_/old.webm", "blob:file:///old", "content://media/old", "file:///old.webm", ""])("recovers old audio from its explicit ID: %s", (src) => {
    expect(JSON.parse(stabilizeNoteContentForPersistence(voice(src, ATTACHMENT_ID), "tiptap-json")).content[0].attrs.src).toBe(`/api/attachments/${ATTACHMENT_ID}`);
  });
  it("uses the imported attachment identity rather than stale metadata", () => {
    const signed = `https://server/api/attachments/${ATTACHMENT_ID}?exp=1&sig=temporary`;
    expect(JSON.parse(stabilizeNoteContentForPersistence(voice(signed, "old-id"), "tiptap-json")).content[0].attrs).toMatchObject({ src: `/api/attachments/${ATTACHMENT_ID}`, attachmentId: ATTACHMENT_ID });
  });
  it("normalizes HTML audio and nested Markdown sources using the parent identity", () => {
    const signed = `https://server/api/attachments/${ATTACHMENT_ID}?exp=1&sig=temporary`;
    expect(stabilizeNoteContentForPersistence(`<audio controls src="${signed}"></audio>`, "html")).toBe(`<audio controls src="/api/attachments/${ATTACHMENT_ID}"></audio>`);
    expect(stabilizeNoteContentForPersistence(`<audio controls data-attachment-id='${ATTACHMENT_ID}'><source src='capacitor://localhost/voice.webm' type='audio/webm'></audio>`, "markdown")).toContain(`<source src='/api/attachments/${ATTACHMENT_ID}'`);
  });
  it("rejects unknown transient audio without silently losing the block", () => {
    for (const src of ["blob:file:///unknown", "capacitor://localhost/unknown", "https://localhost/_capacitor_file_/unknown"]) {
      expect(() => stabilizeNoteContentForPersistence(voice(src), "tiptap-json")).toThrow(TransientNoteAudioSourceError);
      expect(() => stabilizeNoteContentForPersistence(`<audio><source src="${src}"></audio>`, "markdown")).toThrow(TransientNoteAudioSourceError);
    }
  });
  it("preserves external audio, ZIP data audio, and video source tags", () => {
    for (const src of ["https://podcast.example/audio.mp3", "resources/audio.webm", "data:audio/webm;base64,YQ=="]) {
      const content = voice(src, ATTACHMENT_ID);
      expect(stabilizeNoteContentForPersistence(content, "tiptap-json")).toBe(content);
    }
    const video = '<video><source src="blob:file:///video"></video>';
    expect(stabilizeNoteContentForPersistence(video, "html")).toBe(video);
  });
  it("restores a voice node that has only attachment metadata", () => {
    const content = JSON.stringify({ type: "doc", content: [{ type: "voiceMemo", attrs: { attachmentId: ATTACHMENT_ID } }] });
    expect(JSON.parse(stabilizeNoteContentForPersistence(content, "tiptap-json")).content[0].attrs.src).toBe(`/api/attachments/${ATTACHMENT_ID}`);
  });
});
