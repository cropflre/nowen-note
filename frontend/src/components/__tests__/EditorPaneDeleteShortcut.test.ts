import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

// Execute the production handler without mounting the pane's unrelated runtimes.
const source = ts.createSourceFile(
  "EditorPane.tsx",
  readFileSync(path.resolve(__dirname, "../EditorPane.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let handlerSource = "";
function findDeleteHandler(node: ts.Node) {
  if (ts.isVariableDeclaration(node)
      && node.name.getText(source) === "handleKeyDown"
      && node.initializer?.getText(source).includes("setShowDeleteConfirm(true)")) {
    handlerSource = node.initializer.getText(source);
  }
  ts.forEachChild(node, findDeleteHandler);
}
findDeleteHandler(source);
if (!handlerSource) throw new Error("EditorPane Delete handler not found");
const createHandler = new Function(
  "activeNote", "viewLockedIdsRef", "setShowDeleteConfirm",
  ts.transpileModule(`return (${handlerSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
) as (
  note: { id: string; isLocked?: boolean } | null,
  locks: { current: Set<string> },
  confirm: (open: boolean) => void,
) => (event: KeyboardEvent) => void;

afterEach(() => { document.body.innerHTML = ""; });

function pressDelete(
  html: string,
  note: { id: string; isLocked?: boolean } | null = { id: "note-1" },
  locks = new Set<string>(),
) {
  document.body.innerHTML = html;
  const target = document.querySelector<HTMLElement>("[data-focus]")!;
  target.focus();
  expect(document.activeElement).toBe(target);
  const confirm = vi.fn();
  const handler = createHandler(note, { current: locks }, confirm);
  const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
  window.addEventListener("keydown", handler);
  try { target.dispatchEvent(event); }
  finally { window.removeEventListener("keydown", handler); }
  return { confirm, event };
}

describe("EditorPane Delete shortcut", () => {
  it.each([
    ["Markdown", '<div class="cm-editor"><div class="cm-scroller"><div class="cm-content" contenteditable="true" tabindex="0" data-focus></div></div></div>'],
    ["rich text", '<div class="ProseMirror" contenteditable="true" tabindex="0" data-focus></div>'],
    ["input", '<input data-focus />'],
    ["textarea", '<textarea data-focus></textarea>'],
  ])("leaves Delete inside %s to text editing", (_name, html) => {
    const { confirm, event } = pressDelete(html);
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("opens note deletion confirmation outside text editors", () => {
    const { confirm, event } = pressDelete('<button data-focus>Note list</button>');
    expect(confirm).toHaveBeenCalledWith(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["no active note", null, new Set<string>()],
    ["locked note", { id: "note-1", isLocked: true }, new Set<string>()],
    ["view-locked note", { id: "note-1" }, new Set(["note-1"])],
  ])("does not offer deletion for %s", (_name, note, locks) => {
    const { confirm, event } = pressDelete('<button data-focus>Note list</button>', note, locks);
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
