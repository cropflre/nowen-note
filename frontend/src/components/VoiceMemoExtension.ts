import { Node } from "@tiptap/core";

// 此扩展只定义序列化契约，编辑器单独挂载 React NodeView。
export const VoiceMemo = Node.create({
  name: "voiceMemo",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: "", parseHTML: (el) => el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || "" },
      attachmentId: { default: "", parseHTML: (el) => (el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || "").match(/\/api\/attachments\/([^/?#]+)/)?.[1] || el.getAttribute("data-attachment-id") || "", renderHTML: (attrs) => ({ "data-attachment-id": attrs.attachmentId }) },
      filename: { default: "", parseHTML: (el) => el.getAttribute("data-filename") || "", renderHTML: (attrs) => ({ "data-filename": attrs.filename }) },
      mimeType: { default: "", parseHTML: (el) => el.getAttribute("data-mime-type") || el.querySelector("source")?.getAttribute("type") || "", renderHTML: (attrs) => ({ "data-mime-type": attrs.mimeType }) },
      size: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-size")) || 0, renderHTML: (attrs) => ({ "data-size": attrs.size }) },
      durationMs: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-duration-ms")) || 0, renderHTML: (attrs) => ({ "data-duration-ms": attrs.durationMs }) },
    };
  },
  parseHTML() { return [{ tag: "audio" }]; },
  renderHTML({ HTMLAttributes }) { return ["audio", { ...HTMLAttributes, controls: "", preload: "metadata" }]; },
});
