#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve(process.cwd(), process.argv[2] || "tmp/fixtures/editor-performance");
mkdirSync(outputDirectory, { recursive: true });

const paragraphCount = 20_000;
const richText = {
  type: "doc",
  content: Array.from({ length: paragraphCount }, (_, index) => ({
    type: index % 40 === 0 ? "heading" : "paragraph",
    attrs: index % 40 === 0 ? { level: 2, blockId: `heading-${index}` } : { blockId: `paragraph-${index}` },
    content: [{ type: "text", text: `Performance paragraph ${index}: ${"responsive editing ".repeat(5)}` }],
  })),
};

const heavyTypes = ["image", "video", "attachment", "mermaid", "math", "table", "blockEmbed"];
const heavyNodes = {
  type: "doc",
  content: Array.from({ length: 100 }, (_, index) => ({
    type: heavyTypes[index % heavyTypes.length],
    attrs: {
      blockId: `heavy-${index}`,
      src: `https://example.invalid/fixture-${index}`,
      href: `note:00000000-0000-4000-8000-${String(index).padStart(12, "0")}#blk:fixture`,
      source: "graph TD; A-->B",
    },
  })),
};

const codeMarkdown = Array.from({ length: 100 }, (_, index) => (
  `## Code sample ${index}\n\n\`\`\`typescript\nexport const fixture${index} = ${index};\n${"// deterministic workload\n".repeat(100)}\`\`\``
)).join("\n\n");

const files = [
  ["tiptap-20000.generated.json", JSON.stringify(richText)],
  ["heavy-nodes-100.generated.json", JSON.stringify(heavyNodes)],
  ["code-blocks-100.generated.md", codeMarkdown],
];
for (const [name, content] of files) writeFileSync(resolve(outputDirectory, name), content, "utf8");

const manifest = {
  generatedAt: new Date().toISOString(),
  fixtures: files.map(([name, content]) => ({ name, bytes: Buffer.byteLength(content, "utf8") })),
  acceptance: {
    desktop: { inputP50Ms: 16, inputP95Ms: 50 },
    androidLowPower: { inputP50Ms: 33, inputP95Ms: 100 },
    longestTaskMs: 200,
    lifecycle: "no workers or media requests after closing the note",
  },
};
writeFileSync(resolve(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.info(JSON.stringify({ outputDirectory, ...manifest }, null, 2));
