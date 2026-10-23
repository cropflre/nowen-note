import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorImageTransformControls } from "../EditorImageTransformBridge";

const language = vi.hoisted(() => ({ value: "zh-CN" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: language.value } }) }));

describe("image transform controls in the owning editor toolbar", () => {
  let root: Root;
  const editors: Editor[] = [];
  const createEditor = (editable = true) => {
    const editor = new Editor({
      editable,
      extensions: [StarterKit, Image.configure({ inline: true })],
      content: '<p>Before<img src="/same.png" width="320">After</p>',
    });
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    });
    editors.push(editor);
    return editor;
  };
  const click = (label: string) => act(() => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  });
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    language.value = "zh-CN";
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    editors.splice(0).forEach((editor) => editor.destroy());
    document.body.innerHTML = "";
  });

  it("renders direct controls and saves only the owning editor while retaining image selection", () => {
    const first = createEditor();
    const second = createEditor();
    const onUpdate = vi.fn();
    second.on("update", onUpdate);
    act(() => root.render(<EditorImageTransformControls editor={second} />));
    click("向右旋转 90°");
    click("向右旋转 90°");
    const selection = second.state.selection as NodeSelection;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect(selection.node.attrs.rotation).toBe(180);
    expect((first.state.selection as NodeSelection).node.attrs.rotation).toBe(0);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(second.getHTML()).toContain('data-image-rotation="180"');
    expect(second.state.doc.textContent).toBe("BeforeAfter");
    expect(selection.node.attrs.src).toBe("/same.png");
    click("向左旋转 90°");
    expect((second.state.selection as NodeSelection).node.attrs.rotation).toBe(90);
  });

  it("shows mobile rotation controls immediately in English without opening More", () => {
    language.value = "en";
    const editor = createEditor();
    act(() => root.render(<EditorImageTransformControls editor={editor} mobile />));
    expect(document.querySelectorAll('button')).toHaveLength(4);
    click("Rotate left 90°");
    expect((editor.state.selection as NodeSelection).node.attrs.rotation).toBe(270);
    click("Flip horizontally");
    expect(document.querySelector('[aria-label="Flip horizontally"]')?.getAttribute("aria-pressed")).toBe("true");
    click("Reset transform");
    expect((editor.state.selection as NodeSelection).node.attrs).toMatchObject({ rotation: 0, flipX: false });
  });

  it("does not offer mutation controls for a read-only editor", () => {
    const editor = createEditor(false);
    act(() => root.render(<EditorImageTransformControls editor={editor} />));
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});
