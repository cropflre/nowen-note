import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { BulletList } from "@tiptap/extension-bullet-list";
import { ListItem } from "@tiptap/extension-list-item";
import { Heading } from "@tiptap/extension-heading";
import {
  deleteBlock, cutBlock, locateBlock,
  addBlockBelow, getBlockTypeAt, locateTopBlock,
} from "@/components/blockMenuActions";

async function createEditor(content?: any, extraExts: any[] = []) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, BulletList, ListItem, ...extraExts],
    content,
  });
  return { editor, el };
}

/**
 * 回归：块菜单的 删除/复制/剪切 必须能作用于文本块与列表等非文本块。
 * 拖拽柄激活时 from = 外层块起点 + 1，locateBlock 需正确回退到外层块。
 */
describe("block menu delete/cut (regression)", () => {
  it("delete a paragraph", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    });
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isTextblock && node.textContent === "two") { pos = p; return false; }
      return true;
    });
    deleteBlock(editor, pos + 1);
    expect(editor.state.doc.textContent).toBe("one");
    editor.destroy();
    el.remove();
  });

  it("cut a paragraph", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "cutme" }] }],
    });
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isTextblock && node.textContent === "cutme") { pos = p; return false; }
      return true;
    });
    await cutBlock(editor, pos + 1);
    expect(editor.state.doc.textContent).not.toContain("cutme");
    editor.destroy();
    el.remove();
  });

  it("delete a whole bullet list via drag-handle style from", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item1" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item2" }] }] },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    // 拖拽柄在列表上：pos = 列表节点起点(1)，from = 2
    const info = locateBlock(editor, 2, { preferColumn: false });
    expect(info?.typeName).toBe("bulletList");
    deleteBlock(editor, 2);
    expect(editor.state.doc.textContent).toBe("after");
    editor.destroy();
    el.remove();
  });
});

/**
 * 回归：列表 / 容器内「在下方添加」「当前类型判断」必须作用于整段块，
 * 不能把新块塞进列表项内部，也不能把列表项误判成段落。
 */
describe("add-in-list / type detection (regression)", () => {
  it("addBlockBelow inside a list inserts after the whole list, not inside an item", async () => {
    const { editor, el } = await createEditor(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "before" }] },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item1" }] }] },
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item2" }] }] },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      },
      [Heading.configure({ levels: [1, 2, 3] })],
    );
    // 光标落在 item1 段落内
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isTextblock && node.textContent === "item1") { pos = p + 1; return false; }
      return true;
    });
    const newPos = addBlockBelow(editor, "heading1", pos);
    expect(newPos).not.toBeNull();
    // 新标题应出现在「列表之后、after 之前」，而不是嵌套进列表项
    const types: string[] = [];
    editor.state.doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(["paragraph", "bulletList", "heading", "paragraph"]);
    editor.destroy();
    el.remove();
  });

  it("getBlockTypeAt inside a list reports bulletList, not paragraph", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item1" }] }] },
          ],
        },
      ],
    });
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isTextblock && node.textContent === "item1") { pos = p + 1; return false; }
      return true;
    });
    const info = getBlockTypeAt(editor, pos);
    expect(info?.type).toBe("bulletList");
    // 顶层块定位也应返回 bulletList
    const top = locateTopBlock(editor, pos);
    expect(top?.typeName).toBe("bulletList");
    editor.destroy();
    el.remove();
  });
});
