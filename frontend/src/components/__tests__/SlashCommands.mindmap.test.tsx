// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";
import { getDefaultSlashCommands } from "@/components/SlashCommands";

describe("mind map foolproof insertion command", () => {
  it("exposes a searchable /思维导图 command and opens the picker without requiring an ID", () => {
    const commands = getDefaultSlashCommands((key) => key);
    const item = commands.find((command) => command.id === "mindmap");

    expect(item).toBeTruthy();
    expect(item?.label).toBe("思维导图");
    expect(item?.keywords).toEqual(expect.arrayContaining(["脑图", "思维导图", "mindmap"]));

    const handler = vi.fn();
    window.addEventListener("nowen:open-mindmap-insert", handler, { once: true });

    item?.action({} as any);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps the Mermaid code template under a distinct command", () => {
    const commands = getDefaultSlashCommands((key) => key === "slash.mermaidMindMap" ? "Mermaid 脑图（代码块）" : key);
    const item = commands.find((command) => command.id === "mermaidMindMap");
    const editor = new Editor({ extensions: [StarterKit], content: "<p>正文</p>" });
    try {
      expect(item?.label).toBe("Mermaid 脑图（代码块）");
      item?.action(editor);
      const document = editor.getJSON() as { content?: Array<{ type?: string; attrs?: { language?: string }; content?: Array<{ text?: string }> }> };
      expect(document.content?.some((node) =>
        node.type === "codeBlock" && node.attrs?.language === "mermaid" && node.content?.[0]?.text?.startsWith("mindmap"),
      )).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
