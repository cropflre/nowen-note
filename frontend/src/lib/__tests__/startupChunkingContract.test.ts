import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("startup chunking contract", () => {
  it("keeps heavy workspace routes behind exact lazy aliases", () => {
    const config = source("../../../vite.config.ts");

    for (const runtime of [
      "LazyAIChatPanelRuntime.tsx",
      "LazySharedNoteViewRuntime.tsx",
      "LazyCommandPaletteRuntime.tsx",
      "LazySidebarRuntime.tsx",
      "LazyNavRailRuntime.tsx",
      "LazyNoteListRuntime.tsx",
      "LazyEditorSplitViewRuntime.tsx",
      "LazyTaskCenterRuntime.tsx",
      "LazyMindMapEditorRuntime.tsx",
      "LazyDiaryCenterRuntime.tsx",
      "LazyFileManagerRuntime.tsx",
      "LazyShareManagementPageRuntime.tsx",
      "LazyNotebookShareJoinViewRuntime.tsx",
    ]) {
      expect(config).toContain(runtime);
    }
  });

  it("does not combine first-screen UI with archive and Markdown export vendors", () => {
    const config = source("../../../vite.config.ts");

    expect(config).toContain("'vendor-ui'");
    expect(config).toContain("'vendor-markdown'");
    expect(config).toContain("'vendor-archive'");
    expect(config).not.toContain("'vendor-lib'");
  });

  it("loads the editor body through React.lazy", () => {
    const runtime = source("../../components/EditorPaneRuntime.tsx");

    expect(runtime).toContain('React.lazy(() => import("./FormatAwareEditorPane"))');
    expect(runtime).toContain('React.lazy(() => import("./NoteSplitDialog"))');
    expect(runtime).not.toContain('import FormatAwareEditorPane from "./FormatAwareEditorPane"');
  });

  it("keeps AI and public sharing implementations outside the login chunk", () => {
    const aiRuntime = source("../../components/LazyAIChatPanelRuntime.tsx");
    const sharedRuntime = source("../../components/LazySharedNoteViewRuntime.tsx");

    expect(aiRuntime).toContain('React.lazy(() => import("./AIChatReliabilityShell"))');
    expect(sharedRuntime).toContain('React.lazy(() => import("./SharedNoteCommentDisplayRuntime"))');
  });

  it("loads command search only when the palette is open", () => {
    const runtime = source("../../components/common/LazyCommandPaletteRuntime.tsx");

    expect(runtime).toContain('React.lazy(() => import("./CommandPalette"))');
    expect(runtime).toContain("if (!props.open) return null");
  });

  it("does not statically import low-frequency feature centers from the entry module", () => {
    const main = source("../../main.tsx");
    const deferredMount = source("../../components/DeferredGlobalFeatureCentersMount.tsx");
    const deferredCenters = source("../../components/DeferredGlobalFeatureCenters.tsx");

    expect(main).toContain("<DeferredGlobalFeatureCentersMount />");
    expect(main).toContain('React.lazy(() => import("./App"))');
    expect(main).toContain('React.lazy(() => import("./components/PublicNotebookView"))');
    for (const staticImport of [
      'import AIProfileSwitcherBridge from "./components/AIProfileSwitcherBridge"',
      'import EmbeddingIndexTaskCopyBridge from "./components/EmbeddingIndexTaskCopyBridge"',
      'import MarkdownExperienceBridge from "./components/MarkdownExperienceBridge"',
      'import MindMapAppearanceBridge from "./components/MindMapAppearanceBridge"',
      'import NoteImageExportCenter from "./components/NoteImageExportCenter"',
      'import DocxImportCenter from "./components/DocxImportCenter"',
    ]) {
      expect(main).not.toContain(staticImport);
    }
    expect(deferredMount).toContain('import("./DeferredGlobalFeatureCenters")');
    expect(deferredMount).toContain("nowen:token-changed");
    for (const deferredImport of [
      'import AIProfileSwitcherBridge from "./AIProfileSwitcherBridge"',
      'import MarkdownExperienceBridge from "./MarkdownExperienceBridge"',
      'import MindMapAppearanceBridge from "./MindMapAppearanceBridge"',
      'import NoteImageExportCenter from "./NoteImageExportCenter"',
      'import DocxImportCenter from "./DocxImportCenter"',
    ]) {
      expect(deferredCenters).toContain(deferredImport);
    }
  });
});
