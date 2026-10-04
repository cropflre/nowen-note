import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { encryptedBlockFence } from "../blockDocument";
import { prepareMarkdownEncryptedRegionEdit } from "../blockAuthoring";
import fixture from "./fixtures/envelope-v1.json";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it("opens the correct repeated encrypted card through a transformed and segmented preview", () => {
  const source = JSON.stringify({ ...fixture.envelope, kind: "block" });
  const fence = encryptedBlockFence(source);
  const markdown = `math $x$\n\n${fence}\n\n${"public ".repeat(8000)}\n\n${"public ".repeat(10000)}\n\n${fence}`;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: markdown }) });
  let commit!: (source: string) => void;
  try {
    act(() => root.render(<MarkdownPreview markdown={markdown} onEditEncryptedBlock={(original, rendered, offset) => {
      commit = prepareMarkdownEncryptedRegionEdit(view, original, rendered, offset).commit;
    }} />));
    expect(host.querySelectorAll("[data-markdown-segment]").length).toBeGreaterThan(1);
    const cards = host.querySelectorAll('[aria-label="已锁定加密区域"]'); expect(cards.length).toBe(2);
    act(() => cards[1].querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(commit).toBeTypeOf("function");
    const next = JSON.stringify({ ...fixture.envelope, kind: "block", objectId: "10112233-4455-4677-8899-aabbccddeeff" });
    act(() => commit(next));
    expect(view.state.doc.toString()).toBe(markdown.slice(0, markdown.lastIndexOf(fence)) + encryptedBlockFence(next));
  } finally { act(() => root.unmount()); host.remove(); view.destroy(); }
});
