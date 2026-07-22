import { describe, expect, it } from "vitest";
import {
  buildObsidianAssetIndex,
  collectObsidianReferences,
  resolveObsidianAssetPath,
  rewriteObsidianMarkdown,
  scanObsidianFolder,
  type ObsidianEntry,
} from "@/lib/obsidianImportService";

function fileAt(
  path: string,
  content = "x",
  type = "application/octet-stream",
): File {
  const name = path.split("/").pop() || path;
  const file = new File([content], name, {
    type,
    lastModified: 1_700_000_000_000,
  });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

function asset(
  vaultPath: string,
  kind: ObsidianEntry["kind"] = "image",
): ObsidianEntry {
  return {
    relPath: `Vault/${vaultPath}`,
    vaultPath,
    fileName: vaultPath.split("/").pop() || vaultPath,
    notebookPath: vaultPath.split("/").slice(0, -1),
    size: 1,
    lastModified: 1,
    kind,
    selected: true,
    file: fileAt(`Vault/${vaultPath}`),
  };
}

describe("Obsidian Vault scanning", () => {
  it("preserves nested notebook paths and skips .obsidian files", () => {
    const scan = scanObsidianFolder([
      fileAt("Vault/工作/项目 A/阶段一/需求.md", "# 需求"),
      fileAt("Vault/assets/demo.png", "img", "image/png"),
      fileAt("Vault/.obsidian/workspace.json", "{}", "application/json"),
    ]);

    const note = scan.entries.find((entry) => entry.kind === "note");
    expect(scan.rootFolderName).toBe("Vault");
    expect(note?.vaultPath).toBe("工作/项目 A/阶段一/需求.md");
    expect(note?.notebookPath).toEqual(["工作", "项目 A", "阶段一"]);
    expect(scan.stats.folders).toBeGreaterThanOrEqual(4);
    expect(
      scan.entries.find((entry) => entry.relPath.includes(".obsidian"))?.kind,
    ).toBe("skipped");
  });
});

describe("Obsidian attachment resolution", () => {
  it("resolves ./, ../, Chinese and URL encoded paths relative to the note", () => {
    const target = asset("工作/附件/中文 图片.png");
    const index = buildObsidianAssetIndex([target]);

    expect(
      resolveObsidianAssetPath(
        "../附件/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png",
        "工作/项目/需求.md",
        index,
      ).entry?.vaultPath,
    ).toBe(target.vaultPath);
  });

  it("chooses the nearest same-name asset and reports a true tie as ambiguous", () => {
    const near = asset("工作/项目/assets/demo.png");
    const far = asset("生活/assets/demo.png");
    const index = buildObsidianAssetIndex([near, far]);
    expect(
      resolveObsidianAssetPath("demo.png", "工作/项目/需求.md", index).entry
        ?.vaultPath,
    ).toBe(near.vaultPath);

    const tied = buildObsidianAssetIndex([
      asset("A/assets/demo.png"),
      asset("B/assets/demo.png"),
    ]);
    expect(
      resolveObsidianAssetPath("demo.png", "根/需求.md", tied).status,
    ).toBe("ambiguous");
  });

  it("collects and rewrites standard Markdown plus Obsidian image/video/PDF embeds", () => {
    const image = asset("assets/中文 图片.png", "image");
    const video = asset("assets/demo.mp4", "video");
    const pdf = asset("docs/说明.pdf", "pdf");
    const index = buildObsidianAssetIndex([image, video, pdf]);
    const markdown = [
      "![标准图片](<../assets/中文 图片.png>)",
      "![[demo.mp4]]",
      "![[../docs/%E8%AF%B4%E6%98%8E.pdf|说明书]]",
    ].join("\n\n");

    const plans = collectObsidianReferences(markdown, "notes/需求.md", index);
    expect(
      plans.filter((plan) => plan.resolution.status === "resolved"),
    ).toHaveLength(3);

    const rewritten = rewriteObsidianMarkdown(
      markdown,
      "notes/需求.md",
      index,
      new Map([
        [image.vaultPath, "/api/attachments/image"],
        [video.vaultPath, "/api/attachments/video"],
        [pdf.vaultPath, "/api/attachments/pdf"],
      ]),
    );
    expect(rewritten).toContain("![标准图片](/api/attachments/image)");
    expect(rewritten).toContain(
      '<video controls src="/api/attachments/video"></video>',
    );
    expect(rewritten).toContain("[📎 说明书](/api/attachments/pdf)");
  });
});
