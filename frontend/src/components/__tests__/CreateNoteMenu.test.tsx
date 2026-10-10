import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateNoteMenu from "../CreateNoteMenu";
import { KnowledgeTreeCreateDropdown } from "../KnowledgeTreeCreateMenuRuntime";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  list: vi.fn(), listShared: vi.fn(), create: vi.fn(), getNote: vi.fn(), prompt: vi.fn(),
  imports: { markdown: vi.fn(), "markdown-zip": vi.fn(), word: vi.fn(), wechat: vi.fn() },
  template: vi.fn(), pluginTemplate: vi.fn(), error: vi.fn(),
  state: { selectedNotebookId: "book", viewMode: "notebook", notebooks: [{ id: "book" }] },
  actions: { setActiveNote: vi.fn(), addNoteToList: vi.fn(), setMobileView: vi.fn(), refreshNotes: vi.fn(), refreshNotebooks: vi.fn() },
}));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mock.state }), useAppActions: () => mock.actions }));
vi.mock("../KnowledgeTreePanel", () => ({ default: () => null, FOCUS_KNOWLEDGE_TREE_EVENT: "nowen:focus-knowledge-tree", KNOWLEDGE_TREE_CHANGED_EVENT: "nowen:knowledge-tree-changed" }));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { list: mock.list, listShared: mock.listShared, create: mock.create } }));
vi.mock("@/lib/api", () => ({ api: { getNote: mock.getNote }, getCurrentWorkspace: () => "personal" }));
vi.mock("@/lib/knowledgeTreeDuplicateAsChild", () => ({ resolveDuplicableKnowledgeTreeNote: async () => null, duplicateKnowledgeTreeNoteAsChild: vi.fn() }));
vi.mock("@/components/ui/confirm", () => ({ prompt: mock.prompt }));
vi.mock("@/components/knowledgeTreeImport", () => ({
  importMarkdownIntoKnowledgeTree: mock.imports.markdown,
  importMarkdownZipIntoKnowledgeTree: mock.imports["markdown-zip"],
  importWordIntoKnowledgeTree: mock.imports.word,
  importWeChatArticleIntoKnowledgeTree: mock.imports.wechat,
}));
vi.mock("@/lib/noteTemplatesApi", () => ({ noteTemplatesApi: { createNote: mock.template } }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { createNoteFromTemplate: mock.pluginTemplate } }));
vi.mock("@/lib/toast", () => ({ toast: { error: mock.error, success: vi.fn() } }));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({ default: ({ open, onCreate }: { open: boolean; onCreate: (id: string) => Promise<void> }) => open ? <button onClick={() => { void onCreate("template"); }}>选择模板</button> : null }));
vi.mock("@/components/EncryptedNoteCreateDialog", () => ({ default: ({ parentId }: { parentId?: string }) => <div role="dialog" data-parent-id={parentId}>新建加密笔记</div> }));

const folder = { id: "folder", resourceId: "book", resourceType: "notebook", nodeType: "folder", title: "目录", access: { capabilities: { canCreate: true } } };
const note = { id: "new-note", notebookId: "book", title: "新文档" };
describe("note list create menu", () => {
  let root: Root;
  let host: HTMLDivElement;
  let anchor: HTMLButtonElement;
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    mock.list.mockResolvedValue({ nodes: [folder] }); mock.listShared.mockResolvedValue({ nodes: [] });
    mock.create.mockResolvedValue({ id: "new-node", resourceId: note.id }); mock.getNote.mockResolvedValue(note);
    mock.prompt.mockResolvedValue("新文档"); mock.template.mockResolvedValue({ node: { id: "new-node" }, noteId: note.id });
    for (const importer of Object.values(mock.imports)) importer.mockResolvedValue(note);
    host = document.createElement("div"); anchor = document.createElement("button");
    document.body.append(host, anchor); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); anchor.remove(); vi.restoreAllMocks(); });
  let renderCount = 0;
  async function renderMenu(parentId: string | null | undefined = "folder", notebookScope = false) {
    function MenuHost() {
      const [open, setOpen] = React.useState(true);
      const anchorRef = React.useRef(anchor);
      return <CreateNoteMenu open={open} parentId={notebookScope ? undefined : parentId} anchorRef={anchorRef} onPick={vi.fn()} onClose={() => setOpen(false)} />;
    }
    await act(async () => root.render(<MenuHost key={++renderCount} />));
  }
  async function pick(label: string) {
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === label)!.click());
  }
  it("matches tree menu labels, icons, colors and grouping", async () => {
    await renderMenu();
    const listMenu = document.querySelector('[role="menu"]')!.innerHTML;
    await act(async () => root.render(<KnowledgeTreeCreateDropdown menu={{ parentId: "folder", anchor: anchor.getBoundingClientRect() }} onClose={vi.fn()} onCreate={vi.fn()} onCreateFromTemplate={vi.fn()} onCreateEncrypted={vi.fn()} onImport={vi.fn()} />));
    expect(listMenu).toBe(document.querySelector('[role="menu"]')!.innerHTML);
  });
  it.each([["富文本文档", "note"], ["Markdown 文档", "markdown"], ["思维导图", "mindmap"], ["轻量表格", "sheet"], ["文件夹", "folder"]])("creates %s under the selected directory", async (label, kind) => {
    await renderMenu(); await pick(label);
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: "folder", nodeType: kind }));
    expect(mock.actions.refreshNotebooks).toHaveBeenCalled();
  });
  it("resolves a selected notebook when no explicit tree parent is available", async () => {
    await renderMenu(undefined, true); await pick("Markdown 文档");
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: "folder" }));
  });
  it("keeps an explicit root selection at the root", async () => {
    await renderMenu(null); await pick("富文本文档");
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));
  });
  it.each([["导入 Markdown 文件", "markdown"], ["导入 Markdown + 附件（ZIP）", "markdown-zip"], ["导入 Word 文档", "word"], ["导入公众号文章", "wechat"]] as const)("imports %s into the same directory", async (label, kind) => {
    await renderMenu(); await pick(label);
    expect(mock.imports[kind]).toHaveBeenCalledWith(expect.objectContaining({ parent: folder }));
    expect(mock.actions.setActiveNote).toHaveBeenCalledWith(note);
  });
  it("does not silently fall back to the root when the target is gone", async () => {
    mock.list.mockResolvedValue({ nodes: [] });
    await renderMenu(); await pick("富文本文档");
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.error).toHaveBeenCalled();
  });
  it("respects a read-only directory", async () => {
    mock.list.mockResolvedValue({ nodes: [{ ...folder, access: { capabilities: { canCreate: false } } }] });
    await renderMenu(); await pick("富文本文档");
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.error).toHaveBeenCalled();
  });
  it("respects a locked directory", async () => {
    mock.list.mockResolvedValue({ nodes: [{ ...folder, isPasswordProtected: 1 }] });
    await renderMenu(); await pick("Markdown 文档");
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.error).toHaveBeenCalled();
  });
  it("does not redirect a missing notebook to the root", async () => {
    mock.list.mockResolvedValue({ nodes: [] });
    await renderMenu(undefined, true); await pick("富文本文档");
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.error).toHaveBeenCalled();
  });
  it("creates inside a shared directory using its actual tree parent", async () => {
    mock.list.mockResolvedValue({ nodes: [] }); mock.listShared.mockResolvedValue({ nodes: [folder] });
    await renderMenu(); await pick("Markdown 文档");
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: "folder" }));
  });
  it("cancelling an import does not change the active document", async () => {
    mock.imports.word.mockResolvedValue(null);
    await renderMenu(); await pick("导入 Word 文档");
    expect(mock.actions.setActiveNote).not.toHaveBeenCalled();
  });
  it("reports create failures without opening another document", async () => {
    mock.create.mockRejectedValue(new Error("创建失败"));
    await renderMenu(); await pick("富文本文档");
    expect(mock.actions.setActiveNote).not.toHaveBeenCalled(); expect(mock.error).toHaveBeenCalledWith("创建失败");
  });
  it("cancelling folder naming creates nothing", async () => {
    mock.prompt.mockResolvedValue(null);
    await renderMenu(); await pick("文件夹"); expect(mock.create).not.toHaveBeenCalled();
  });
  it("keeps the selected directory for templates and encryption", async () => {
    await renderMenu(); await pick("从模板新建"); await pick("选择模板");
    expect(mock.template).toHaveBeenCalledWith("template", "folder");
    await renderMenu(); await pick("加密笔记");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("data-parent-id")).toBe("folder");
  });
});
