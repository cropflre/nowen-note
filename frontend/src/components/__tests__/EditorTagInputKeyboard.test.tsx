import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TagInput from "../TagInput";
import { cn } from "@/lib/utils";
import type { Tag } from "@/types";

const mocks = vi.hoisted(() => ({ create: vi.fn(), attach: vi.fn(), setTags: vi.fn(), state: { tags: [] as Tag[] } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => ({ setTags: mocks.setTags }),
}));
vi.mock("@/lib/api", () => ({ api: {
  createTag: mocks.create, addTagToNote: mocks.attach, getTags: async () => [],
} }));
vi.mock("@/components/TagColorPicker", () => ({ default: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Render each editor's production tag section without starting its document runtime.
function tagSection(file: string) {
  const source = ts.createSourceFile(file, readFileSync(path.resolve(__dirname, "..", file), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "TagInput") {
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isJsxExpression(parent)) parent = parent.parent;
      if (parent && ts.isJsxExpression(parent)) expression = parent.expression!.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`${file}: tag section not found`);
  const render = new Function("React", "TagInput", "cn", "compactMobileEditing", "isGuest",
    "windowedSection", "note", "noteTags", "onTagsChange",
    ts.transpileModule(`return (${expression});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    }).outputText);
  return (compact: boolean, tags: Tag[], onTagsChange: (tags: Tag[]) => void, guest = false) =>
    render(React, TagInput, cn, compact, guest, false, { id: "note-1", tags }, tags, onTagsChange) as React.ReactNode;
}

const existingTag: Tag = { id: "existing", userId: "user-1", name: "已有标签", color: "#58a6ff", createdAt: "2026-10-08" };
const addedTag: Tag = { ...existingTag, id: "added", name: "新标签" };
let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue(addedTag);
  mocks.attach.mockResolvedValue({});
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

for (const file of ["TiptapEditor.tsx", "MarkdownEditorImpl.tsx"]) {
  const render = tagSection(file);
  describe(`${file} 标签输入与安卓键盘`, () => {
    it.each([{ count: 0, tags: [] }, { count: 1, tags: [existingTag] }])("键盘弹出保留输入框、焦点与草稿，并可提交标签（已有 $count）", async ({ tags: noteTags }) => {
      const changed = vi.fn();
      await act(async () => root.render(render(false, noteTags, changed)));
      if (noteTags.length) {
        await act(async () => {
          host.querySelector<HTMLButtonElement>('[aria-label="tags.addTagPlaceholder"]')!.click();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });
      }
      const input = host.querySelector("input")!;
      await act(async () => input.focus());
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, "新标签");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => root.render(render(true, noteTags, changed)));
      expect(host.querySelector("input")).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("新标签");
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(mocks.create).toHaveBeenCalledWith({ name: "新标签" });
      expect(mocks.attach).toHaveBeenCalledWith("note-1", "added");
      expect(changed).toHaveBeenCalledWith([...noteTags, addedTag]);
    });

    it("正文编辑时收起标签栏，但不卸载组件", async () => {
      await act(async () => root.render(render(true, [], vi.fn())));
      const input = host.querySelector("input");
      expect(input).not.toBeNull();
      const wrapper = host.querySelector(".tag-input-area")!.parentElement!;
      expect(wrapper.classList.contains("hidden")).toBe(true);
      expect(wrapper.classList.contains("focus-within:block")).toBe(true);
    });

    it("访客模式仍隐藏标签编辑", async () => {
      await act(async () => root.render(render(false, [], vi.fn(), true)));
      expect(host.querySelector(".tag-input-area")).toBeNull();
    });
  });
}
