import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const componentsDir = path.resolve(__dirname, "..");
const importSource = readFileSync(path.join(componentsDir, "ObsidianImport.tsx"), "utf8");
const desktopTree = readFileSync(path.join(componentsDir, "KnowledgeTreePanel.tsx"), "utf8");
const mobileTree = readFileSync(path.join(componentsDir, "MobileKnowledgeTreePanel.tsx"), "utf8");

describe("Obsidian Import V2 UX guards (#763)", () => {
  it("exposes explicit duplicate import policies", () => {
    expect(importSource).toContain('["skip", "跳过"]');
    expect(importSource).toContain('["update", "更新"]');
    expect(importSource).toContain('["duplicate", "保留副本"]');
    expect(importSource).toContain("duplicateStrategy");
  });

  it("keeps unreferenced attachment import opt-in", () => {
    expect(importSource).toContain("includeUnusedAttachments");
    expect(importSource).toContain("导入未被引用的附件");
    expect(importSource).toContain("默认关闭");
  });

  it("opens imported file resources with the existing attachment drawer on desktop and mobile", () => {
    for (const source of [desktopTree, mobileTree]) {
      expect(source).toContain('node.resourceType === "file"');
      expect(source).toContain("setPreviewFileId(node.resourceId)");
      expect(source).toContain("<AttachmentDetailDrawer");
      expect(source).toContain("attachmentId={previewFileId}");
    }
  });
});
