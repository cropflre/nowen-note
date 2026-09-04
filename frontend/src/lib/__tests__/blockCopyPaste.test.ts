import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import { copyBlock, pasteBlock, convertBlock } from "@/components/blockMenuActions";

async function createEditor(content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({ element: el, extensions: [StarterKit, CalloutExtension], content });
  return { editor, el };
}

function blockHandleFrom(editor: Editor, index: number): number {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph") positions.push(pos + 1);
    return true;
  });
  return positions[index] ?? -1;
}

function texts(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "paragraph") out.push(node.textContent || "(空)");
    return true;
  });
  return out;
}

// 用带 .text() 的普通对象模拟 ClipboardItem/Clipboard.read，避免 jsdom Blob 无 .text()
function installMockClipboard(initial?: { html?: string; text?: string }) {
  const store: { html?: string; text?: string } = initial ? { ...initial } : {};
  const clipboard = {
    write: async (items: any[]) => {
      const item = items[0];
      if (item && typeof item.get === "function") {
        const types = item.types as string[];
        if (types.includes("text/html")) store.html = await item.get("text/html");
        if (types.includes("text/plain")) store.text = await item.get("text/plain");
      }
    },
    // 在无 ClipboardItem 的 jsdom 里 copyBlock 不会调用 write，这里仅供 pasteBlock 读取
    read: async () => {
      const types: string[] = [];
      if (store.html) types.push("text/html");
      if (store.text) types.push("text/plain");
      return [{
        types,
        getType: async (t: string) => ({ text: async () => (t === "text/html" ? store.html! : store.text!) }),
      }];
    },
  };
  try { (navigator as any).clipboard = clipboard; } catch {
    try { Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true, writable: true }); } catch { /* ignore */ }
  }
  return { clipboard, store };
}

beforeEach(() => {
  try { (navigator as any).clipboard = undefined; } catch { try { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); } catch {} }
});

describe("pasteBlock 插入位置（块2的柄点粘贴 → 内容落在点击行，而非下一行）", () => {
  it("非空块2：粘贴内容插在块2「之前」，不落到块3", async () => {
    const { store } = installMockClipboard({ html: "<p>PASTED</p>", text: "PASTED" });
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
        { type: "paragraph", content: [{ type: "text", text: "C" }] },
      ],
    });
    const from2 = blockHandleFrom(editor, 1);
    console.log("[test] 块2 from =", from2, "doc size =", editor.state.doc.content.size);
    const ok = await pasteBlock(editor, from2);
    console.log("[test] pasteBlock ok =", ok, "texts =", JSON.stringify(texts(editor)));
    expect(ok).toBe(true);
    // 粘在点击行之前：A / PASTED / B / C（B 仍在，块3=C 不变）
    expect(texts(editor)).toEqual(["A", "PASTED", "B", "C"]);
    editor.destroy(); el.remove();
  });

  it("空块2：粘贴后内容替换空块2，落在点击行（不再出现于块3）", async () => {
    const { store } = installMockClipboard({ html: "<p>PASTED</p>", text: "PASTED" });
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "C" }] },
      ],
    });
    const from2 = blockHandleFrom(editor, 1); // 空块2
    const ok = await pasteBlock(editor, from2);
    console.log("[test-empty] ok =", ok, "texts =", JSON.stringify(texts(editor)));
    expect(ok).toBe(true);
    // 空块被替换为 PASTED，内容就在点击行：A / PASTED / C
    expect(texts(editor)).toEqual(["A", "PASTED", "C"]);
    editor.destroy(); el.remove();
  });

  it("复制块2的 data-pm-slice html 回贴（模拟真实复制→粘贴链路）", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
        { type: "paragraph", content: [{ type: "text", text: "C" }] },
      ],
    });
    const from2 = blockHandleFrom(editor, 1);
    // 模拟 copyBlock 实际写入剪贴板的 html（serializeForClipboard 产物）
    editor.commands.setTextSelection({ from: from2, to: from2 + 1 });
    const slice = editor.state.selection.content();
    const { dom } = editor.view.serializeForClipboard(slice);
    const copiedHtml = dom.outerHTML;
    console.log("[roundtrip] copied html =", copiedHtml);
    // 把它放进模拟剪贴板，再粘贴到块2的柄
    const { store } = installMockClipboard({ html: copiedHtml, text: "B" });
    const ok = await pasteBlock(editor, from2);
    console.log("[roundtrip] ok =", ok, "texts =", JSON.stringify(texts(editor)));
    expect(ok).toBe(true);
    expect(texts(editor)).toEqual(["A", "B", "B", "C"]);
    editor.destroy(); el.remove();
  });
});

describe("serializeForClipboard 生成 data-pm-slice（决定 Ctrl+V 能否还原）", () => {
  function serializeBlock(editor: Editor, from: number): string {
    const view = editor.view;
    // 选中整块
    editor.commands.setTextSelection({ from, to: from + 1 });
    const slice = editor.state.selection.content();
    const { dom } = view.serializeForClipboard(slice);
    return dom.outerHTML;
  }

  it("段落：html 含 data-pm-slice", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
        { type: "paragraph", content: [{ type: "text", text: "C" }] },
      ],
    });
    const html = serializeBlock(editor, 1);
    console.log("[ser] 段落 html =", html);
    console.log("[ser] 含 data-pm-slice =", html.includes("data-pm-slice"));
    expect(html.includes("data-pm-slice")).toBe(true);
    editor.destroy(); el.remove();
  });

  it("高亮块（callout）：html 含 data-pm-slice（自定义节点还原关键）", async () => {
    const { editor, el } = await createEditor({ type: "doc", content: [{ type: "paragraph" }] });
    await convertBlock(editor, { type: "callout" }, 1);
    let calloutParaFrom = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && calloutParaFrom < 0) { calloutParaFrom = pos + 1; return false; }
      return true;
    });
    const html = serializeBlock(editor, calloutParaFrom);
    console.log("[ser-callout] html =", html);
    console.log("[ser-callout] 含 data-pm-slice =", html.includes("data-pm-slice"));
    expect(html.includes("data-pm-slice")).toBe(true);
    editor.destroy(); el.remove();
  });
});
