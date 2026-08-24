import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableHeader, TableRow, TableCell } from "@tiptap/extension-table";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import { MathBlock } from "@/components/MathExtensions";
import {
  convertBlock, addBlockBelow, deleteBlock, cutBlock,
  type BlockTarget, type AddBelowType,
} from "@/components/blockMenuActions";

/**
 * 块柄 / 斜杠菜单共享的块操作回归测试。
 *
 * 背景（2026-08-21 修复）：
 * 1. buildBelowNode 用 schema.nodes["blockQuote"]（大写 Q）→ 真实节点名是 blockquote，
 *    导致「在下方添加 → 引用」与分栏内「转化为 → 引用」抛 TypeError。
 * 2. convertBlock 在 callout 内「段落→段落」因 unwrapContainer 后继续用过期 state
 *    抛 "Applying a mismatched transaction"。
 * 3. convertInColumn 容器换容器（解包后重包）路径同样用过期 state。
 * 本测试用真实扩展集（StarterKit + Details/Callout/Columns/Table/TaskList/Math）锁死这些行为。
 */

async function createEditor(content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit, Details, DetailsSummary, DetailsContent, TaskList, TaskItem,
      Table.configure({}), TableHeader, TableRow, TableCell,
      ColumnsExtension, CalloutExtension, MathBlock,
    ],
    content,
  });
  return { editor, el };
}

function nodePosOf(editor: Editor, typeName: string): number {
  let pos = -1;
  editor.state.doc.descendants((n, p) => { if (n.type.name === typeName && pos < 0) { pos = p; return false; } return true; });
  return pos;
}

const CONVERT_TARGETS: BlockTarget[] = [
  { type: "paragraph" }, { type: "heading", level: 1 }, { type: "heading", level: 2 },
  { type: "bulletList" }, { type: "orderedList" }, { type: "taskList" },
  { type: "callout" }, { type: "blockquote" }, { type: "codeBlock" },
  { type: "columns" }, { type: "details" },
];
const ADD_BELOW: AddBelowType[] = [
  "paragraph", "heading1", "bulletList", "orderedList", "taskList",
  "blockquote", "codeBlock", "details", "callout", "columns", "table", "math",
];

const SCENARIOS = [
  {
    name: "普通段落",
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
    // 设计上拒绝的目标：无（普通段落可转任意目标）
    convertSkipped: [] as string[],
  },
  {
    name: "callout内段落",
    content: { type: "doc", content: [{ type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }] },
    // callout 内再包 callout = 已是该容器 → 解包语义，convertBlock 返回 false（设计如此）
    convertSkipped: ["callout"],
  },
  {
    name: "column内段落",
    content: { type: "doc", content: [{ type: "column_container", content: [{ type: "column", attrs: { colWidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }, { type: "column", attrs: { colWidth: null }, content: [{ type: "paragraph" }] }] }] },
    // column 内再套 columns = 设计拒绝（保持单层分栏）
    convertSkipped: ["columns"],
  },
];

describe("块柄 from 下块操作完整矩阵（回归）", () => {
  for (const sc of SCENARIOS) {
    it(`[${sc.name}] convert 各目标均成功且不崩溃`, async () => {
      for (const t of CONVERT_TARGETS) {
        const { editor, el } = await createEditor(sc.content);
        const from = nodePosOf(editor, "paragraph") + 1;
        let ok = false, err = "";
        try { ok = convertBlock(editor, t, from); } catch (e) { err = String(e); }
        expect(err, `[${sc.name}] convert->${t.type} 不应抛异常`).toBe("");
        if (sc.convertSkipped.includes(t.type)) {
          expect(ok, `[${sc.name}] convert->${t.type} 应为设计拒绝(false)`).toBe(false);
        } else {
          expect(ok, `[${sc.name}] convert->${t.type} 应成功`).toBe(true);
        }
        editor.destroy(); el.remove();
      }
    });

    it(`[${sc.name}] addBelow 各目标均成功且不崩溃`, async () => {
      for (const t of ADD_BELOW) {
        const { editor, el } = await createEditor(sc.content);
        const from = nodePosOf(editor, "paragraph") + 1;
        let ret: number | null = null, err = "";
        try { ret = addBlockBelow(editor, t, from); } catch (e) { err = String(e); }
        expect(err, `[${sc.name}] addBelow->${t} 不应抛异常`).toBe("");
        expect(ret, `[${sc.name}] addBelow->${t} 应返回新位置`).not.toBeNull();
        editor.destroy(); el.remove();
      }
    });
  }

  it("delete / duplicate / cut 首个块（from=1，即 pos=0 块柄场景）", async () => {
    // delete：删首个块后剩 1 块
    {
      const { editor, el } = await createEditor({
        type: "doc", content: [
          { type: "paragraph", content: [{ type: "text", text: "A" }] },
          { type: "paragraph", content: [{ type: "text", text: "B" }] },
        ],
      });
      deleteBlock(editor, 1);
      expect(editor.getJSON().content.length).toBe(1);
      editor.destroy(); el.remove();
    }
    // cut：剪切首个块 → 1 块
    {
      const { editor, el } = await createEditor({
        type: "doc", content: [
          { type: "paragraph", content: [{ type: "text", text: "A" }] },
          { type: "paragraph", content: [{ type: "text", text: "B" }] },
        ],
      });
      await cutBlock(editor, 1);
      expect(editor.getJSON().content.length).toBe(1);
      editor.destroy(); el.remove();
    }
  });

  it("addBelow->blockquote 不再因节点名崩溃且产出 blockquote", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
    });
    const ret = addBlockBelow(editor, "blockquote", 1);
    expect(ret).not.toBeNull();
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain("blockquote");
    editor.destroy(); el.remove();
  });
});
