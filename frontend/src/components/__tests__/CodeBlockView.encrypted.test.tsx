import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import CodeBlock from "@tiptap/extension-code-block";
import { EditorContent, ReactNodeViewRenderer } from "@tiptap/react";
import { expect, it } from "vitest";
import { CodeBlockView } from "@/components/CodeBlockView";
import { ENCRYPTED_BLOCK_LANGUAGE } from "@/lib/encryptedNotes/blockDocument";
import fixture from "@/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = JSON.stringify({ ...fixture.envelope, kind: "block" });
const encryptedNode = (text: string) => ({
  type: "codeBlock", attrs: { language: ENCRYPTED_BLOCK_LANGUAGE }, content: [{ type: "text", text }],
});
const EncryptedCodeBlock = CodeBlock.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView); },
});

it.each([true, false])("hides encrypted node content after insertion and reload (editable=%s)", async (editable) => {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, EncryptedCodeBlock], editable,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Public text" }] }] },
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const assertHiddenCiphertext = (expected: string) => {
    const content = host.querySelector<HTMLElement>("[data-node-view-content-react]")!;
    expect(content).not.toBeNull();
    expect(content.textContent).toBe(expected);
    expect(content.closest("[hidden][aria-hidden='true']")).not.toBeNull();
    const visible = host.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("[hidden]").forEach((node) => node.remove());
    expect(visible.textContent).toContain("🔒 加密内容");
    expect(visible.textContent).toContain("Public text");
    expect(visible.textContent).not.toContain("ciphertext");
    expect(visible.textContent).not.toContain("objectId");
  };
  try {
    await act(async () => root.render(<EditorContent editor={editor} />));
    await act(async () => { editor.commands.insertContentAt(1, encryptedNode(source)); });
    assertHiddenCiphertext(source);
    const saved = editor.getJSON();
    expect(JSON.stringify(saved)).toContain("ciphertext");
    await act(async () => { editor.commands.setContent(saved); });
    assertHiddenCiphertext(source);
    const next = JSON.stringify({ ...fixture.envelope, kind: "block", objectId: "10112233-4455-4677-8899-aabbccddeeff" });
    let position = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "codeBlock") position = pos; });
    await act(async () => {
      editor.commands.insertContentAt({ from: position, to: position + editor.state.doc.nodeAt(position)!.nodeSize }, encryptedNode(next));
    });
    assertHiddenCiphertext(next);
    expect(JSON.stringify(editor.getJSON())).toContain("10112233-4455-4677-8899-aabbccddeeff");
  } finally {
    await act(async () => root.unmount()); editor.destroy(); host.remove();
  }
});
