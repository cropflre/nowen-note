#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve(process.cwd(), process.argv[2] || "tmp/fixtures/editor-performance");
mkdirSync(outputDirectory, { recursive: true });

function createRichText(paragraphCount) {
  return {
  type: "doc",
  content: Array.from({ length: paragraphCount }, (_, index) => {
    const suffix = String(index).padStart(6, "0");
    return {
      type: index % 40 === 0 ? "heading" : "paragraph",
      attrs: index % 40 === 0
        ? { level: 2, blockId: `blk_heading_${suffix}` }
        : { blockId: `blk_paragraph_${suffix}` },
      content: [{ type: "text", text: `Performance paragraph ${index}: ${"responsive editing ".repeat(5)}` }],
    };
  }),
  };
}

const richText20k = createRichText(20_000);
const richText500 = createRichText(500);
const richText50k = createRichText(50_000);

const heavyTypes = ["image", "video", "attachment", "mermaid", "math", "table", "blockEmbed"];
function createHeavyNodes(count) {
  return {
  type: "doc",
  content: Array.from({ length: count }, (_, index) => ({
    type: heavyTypes[index % heavyTypes.length],
    attrs: {
      blockId: `blk_heavy_${String(index).padStart(6, "0")}`,
      src: `https://example.invalid/fixture-${index}`,
      href: `note:00000000-0000-4000-8000-${String(index).padStart(12, "0")}#blk:fixture`,
      source: "graph TD; A-->B",
    },
  })),
  };
}

const heavyNodes100 = createHeavyNodes(100);
const heavyNodes500 = createHeavyNodes(500);

function createMediaNodes(count) {
  return {
  type: "doc",
  content: Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(6, "0");
    const attrs = {
      blockId: `blk_media_${suffix}`,
      src: `https://example.invalid/media-${index}`,
    };
    if (index % 2 === 0) {
      return {
        type: "paragraph",
        attrs: { blockId: attrs.blockId },
        content: [{ type: "image", attrs: { src: attrs.src } }],
      };
    }
    return { type: "video", attrs };
  }),
  };
}

const mediaNodes100 = createMediaNodes(100);
const mediaNodes500 = createMediaNodes(500);

function createCodeMarkdown(count) {
  return Array.from({ length: count }, (_, index) => (
  `## Code sample ${index}\n\n\`\`\`typescript\nexport const fixture${index} = ${index};\n${"// 确定性负载\n".repeat(100)}\`\`\``
  )).join("\n\n");
}

const codeMarkdown100 = createCodeMarkdown(100);
const codeMarkdown500 = createCodeMarkdown(500);

const files = [
  { name: "tiptap-500.generated.json", type: "tiptap", nodeCount: 500, content: JSON.stringify(richText500) },
  { name: "tiptap-20000.generated.json", type: "tiptap", nodeCount: 20_000, content: JSON.stringify(richText20k) },
  { name: "tiptap-50000.generated.json", type: "tiptap", nodeCount: 50_000, content: JSON.stringify(richText50k) },
  { name: "media-nodes-100.generated.json", type: "media", nodeCount: 100, content: JSON.stringify(mediaNodes100) },
  { name: "media-nodes-500.generated.json", type: "media", nodeCount: 500, content: JSON.stringify(mediaNodes500) },
  { name: "code-blocks-100.generated.md", type: "code", nodeCount: 100, content: codeMarkdown100 },
  { name: "code-blocks-500.generated.md", type: "code", nodeCount: 500, content: codeMarkdown500 },
  { name: "heavy-nodes-100.generated.json", type: "mixed-heavy", nodeCount: 100, content: JSON.stringify(heavyNodes100) },
  { name: "heavy-nodes-500.generated.json", type: "mixed-heavy", nodeCount: 500, content: JSON.stringify(heavyNodes500) },
];
for (const { name, content } of files) writeFileSync(resolve(outputDirectory, name), content, "utf8");

const manifest = {
  schemaVersion: 1,
  fixtures: files.map(({ name, type, nodeCount, content }) => ({
    name,
    type,
    nodeCount,
    bytes: Buffer.byteLength(content, "utf8"),
  })),
  acceptance: {
    desktop: { inputP50Ms: 16, inputP95Ms: 50 },
    androidLowPower: { inputP50Ms: 33, inputP95Ms: 100 },
    longestTaskMs: 200,
    lifecycle: "no workers, NodeViews, or media requests after closing the note",
  },
};
writeFileSync(resolve(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.info(JSON.stringify({ outputDirectory, ...manifest }, null, 2));
