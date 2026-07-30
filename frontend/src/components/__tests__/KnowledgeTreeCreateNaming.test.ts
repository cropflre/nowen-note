import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreeCreateMenuRuntime.tsx"), "utf8");
const panelSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreePanel.tsx"), "utf8");
const quickPanelSource = readFileSync(path.resolve(__dirname, "../MobileKnowledgeTreePanel.tsx"), "utf8");

describe("knowledge tree create naming", () => {
  it("hands dropdown selections to the inline naming draft before creating", () => {
    expect(runtimeSource).toContain("setCreateRequest({");
    expect(runtimeSource).toContain("<KnowledgeTreePanelBase {...props} createRequest={createRequest}");
    expect(runtimeSource).not.toContain("knowledgeTreeApi.create({");
    expect(panelSource).toContain("createRequest?: KnowledgeTreeInlineCreateRequest;");
    expect(panelSource).toContain("startInlineCreate(parent, createRequest.kind);");
  });

  it("offers Markdown, Word and WeChat article imports from the plus menu", () => {
    expect(runtimeSource).toContain('label: "导入 Markdown 文件"');
    expect(runtimeSource).toContain('label: "导入 Word 文档"');
    expect(runtimeSource).toContain('label: "导入公众号文章"');
    expect(runtimeSource).toContain("也可将 .md 文件拖拽到目录树导入");
    expect(runtimeSource).toContain("setImportRequest({");
    expect(runtimeSource).toContain("importRequest={importRequest}");
    expect(panelSource).toContain("importRequest?: KnowledgeTreeImportRequest;");
    expect(panelSource).toContain("importWordIntoKnowledgeTree");
    expect(panelSource).toContain("importMarkdownIntoKnowledgeTree");
    expect(panelSource).toContain("importWeChatArticleIntoKnowledgeTree");
    expect(quickPanelSource).toContain("importMarkdownIntoKnowledgeTree");
  });

  it("uses the tree-style anchored menu and inline naming in quick browse", () => {
    expect(runtimeSource).toContain("export function KnowledgeTreeCreateDropdown");
    expect(quickPanelSource).toContain("<KnowledgeTreeCreateDropdown");
    expect(quickPanelSource).toContain("data-mobile-knowledge-tree-inline-create");
    expect(quickPanelSource).toContain("startInlineCreate");
    expect(quickPanelSource).toContain("commitDraft");
    expect(quickPanelSource).not.toContain("const openCreateMenu = useCallback(async");
  });
});
