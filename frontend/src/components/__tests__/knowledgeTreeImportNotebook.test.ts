import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
const listShared = vi.hoisted(() => vi.fn());

vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: {
    list,
    listShared,
  },
}));

vi.mock("@/lib/api", () => ({
  api: {},
}));

vi.mock("@/components/ui/confirm", () => ({
  prompt: vi.fn(),
}));

vi.mock("@/lib/knowledgeTreeMarkdownDrop", () => ({
  importMarkdownFileIntoKnowledgeTree: vi.fn(),
  MAX_MARKDOWN_DROP_FILES: 100,
  MAX_MARKDOWN_DROP_FILE_SIZE: 20 * 1024 * 1024,
  MAX_MARKDOWN_DROP_TOTAL_SIZE: 100 * 1024 * 1024,
  pickMarkdownFiles: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    info: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { resolveKnowledgeTreeImportOptionsForNotebook } from "@/components/knowledgeTreeImport";

function notebookNode(id: string, notebookId: string, canCreate = true) {
  return {
    id,
    resourceType: "notebook",
    resourceId: notebookId,
    access: { capabilities: { canCreate } },
  } as any;
}

describe("resolveKnowledgeTreeImportOptionsForNotebook", () => {
  beforeEach(() => {
    list.mockReset();
    listShared.mockReset();
  });

  it("maps a three-column notebook selection to the matching owned tree node", async () => {
    const parent = notebookNode("notebook:nb-1", "nb-1");
    list.mockResolvedValue({ nodes: [parent] });
    listShared.mockResolvedValue({ nodes: [] });

    const result = await resolveKnowledgeTreeImportOptionsForNotebook("nb-1");
    expect(result.parent).toBe(parent);
    expect(result.fallbackNotebookId).toBe("nb-1");
  });

  it("also resolves shared notebook nodes and enforces create permission", async () => {
    list.mockResolvedValue({ nodes: [] });
    listShared.mockResolvedValue({ nodes: [notebookNode("shared:nb-2", "nb-2", false)] });

    await expect(resolveKnowledgeTreeImportOptionsForNotebook("nb-2"))
      .rejects.toThrow("没有在当前目录中导入内容的权限");
  });

  it("does not silently import at the root when the selected directory disappeared", async () => {
    list.mockResolvedValue({ nodes: [] });
    listShared.mockResolvedValue({ nodes: [] });

    await expect(resolveKnowledgeTreeImportOptionsForNotebook("missing"))
      .rejects.toThrow("当前目录已不存在");
  });
});
