import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const scriptPath = resolve("scripts/generate-editor-performance-fixtures.mjs");

test("连续两次生成完全一致的 manifest 和样本内容", () => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "nowen-editor-performance-"));
  const firstOutputDirectory = resolve(temporaryDirectory, "first");
  const secondOutputDirectory = resolve(temporaryDirectory, "second");
  try {
    execFileSync(process.execPath, [scriptPath, firstOutputDirectory], { stdio: "pipe" });
    execFileSync(process.execPath, [scriptPath, secondOutputDirectory], { stdio: "pipe" });
    const firstManifestText = readFileSync(resolve(firstOutputDirectory, "manifest.json"), "utf8");
    const secondManifestText = readFileSync(resolve(secondOutputDirectory, "manifest.json"), "utf8");
    assert.equal(firstManifestText, secondManifestText);
    const manifest = JSON.parse(firstManifestText);
    for (const { name } of manifest.fixtures) {
      assert.deepEqual(
        readFileSync(resolve(firstOutputDirectory, name)),
        readFileSync(resolve(secondOutputDirectory, name)),
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("生成分离且符合实际 schema 的固定样本", () => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "nowen-editor-performance-"));
  const outputDirectory = resolve(temporaryDirectory, "fixtures");
  try {
    execFileSync(process.execPath, [scriptPath, outputDirectory], { stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(resolve(outputDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal("generatedAt" in manifest, false);
    const expected = [
      ["tiptap-20000.generated.json", "tiptap", 20_000],
      ["tiptap-50000.generated.json", "tiptap", 50_000],
      ["media-nodes-100.generated.json", "media", 100],
      ["media-nodes-500.generated.json", "media", 500],
      ["code-blocks-100.generated.md", "code", 100],
      ["code-blocks-500.generated.md", "code", 500],
    ];
    for (const [name, type, nodeCount] of expected) {
      const fixture = manifest.fixtures.find((item) => item.name === name);
      assert.equal(fixture?.name, name);
      assert.equal(fixture?.type, type);
      assert.equal(fixture?.nodeCount, nodeCount);
      assert.equal(Number.isFinite(fixture?.bytes) && fixture.bytes > 0, true);
    }

    for (const count of [20_000, 50_000]) {
      const tiptap = JSON.parse(readFileSync(resolve(outputDirectory, `tiptap-${count}.generated.json`), "utf8"));
      assert.equal(tiptap.content.every((node) => /^blk_/.test(node.attrs?.blockId)), true);
    }
    for (const count of [100, 500]) {
      const media = JSON.parse(readFileSync(resolve(outputDirectory, `media-nodes-${count}.generated.json`), "utf8"));
      assert.equal(media.content.length, count);
      assert.equal(media.content.some((node) => node.type === "image"), false);
      assert.equal(media.content.every((node) => /^blk_/.test(node.attrs?.blockId)), true);
      assert.equal(media.content.every((node) => (
        node.type === "video"
        || (node.type === "paragraph" && node.content?.length === 1 && node.content[0].type === "image")
      )), true);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
