import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { createResizableImageNodeView } from "../ResizableImageView";

describe("attachment image before React EditorContent mounts", () => {
  it("does not emit an unsigned image element but preserves its document and HTML export", () => {
    const src = "/api/attachments/123e4567-e89b-42d3-a456-426614174216";
    const editor = new Editor({
      extensions: [StarterKit, Image.extend({ addNodeView() { return createResizableImageNodeView(); } })],
      content: { type: "doc", content: [{ type: "image", attrs: { src } }] },
    });
    try {
      expect(editor.view.dom.querySelector("img[src]")).toBeNull();
      expect(editor.getJSON().content?.[0].attrs?.src).toBe(src);
      expect(editor.getHTML()).toContain(`src="${src}"`);
      expect(editor.getHTML()).not.toContain("sig=");
    } finally { editor.destroy(); }
  });
});
