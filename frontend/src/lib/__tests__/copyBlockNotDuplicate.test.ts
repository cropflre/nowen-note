import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import {
  convertBlock, copyBlock,
} from "@/components/blockMenuActions";

/**
 * 回归测试：菜单「复制」必须只复制到剪贴板、不得改动文档（不得原地插入副本）。
 */

async function createEditor(content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, CalloutExtension],
    content,
  });
  return { editor, el };
}

function blockCount(editor: Editor): number {
  let n = 0;
  editor.state.doc.descendants((node) => { if (node.isBlock) n++; return true; });
  return n;
}

describe("copyBlock 不该改动文档", () => {
  it("普通段落：copyBlock 后文档不变（不插入副本）", async () => {
    const { editor, el } = await createEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] });
    const before = JSON.stringify(editor.getJSON());
    const beforeCount = blockCount(editor);
    const ok = await copyBlock(editor, 1);
    // 测试环境通常无 clipboard 实现，返回 false 是可接受的；关键是文档不能变
    expect(typeof ok).toBe("boolean");
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(blockCount(editor)).toBe(beforeCount);
    editor.destroy(); el.remove();
  });

  it("callout 容器：copyBlock 后文档不变", async () => {
    const { editor, el } = await createEditor({ type: "doc", content: [{ type: "paragraph" }] });
    convertBlock(editor, { type: "callout" }, 1);
    const before = JSON.stringify(editor.getJSON());
    await copyBlock(editor, 1);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    editor.destroy(); el.remove();
  });
});
