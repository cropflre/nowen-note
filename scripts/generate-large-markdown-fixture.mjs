#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TARGET_BYTES = 2_412_624;
const TARGET_LINES = 45_939;
const TOOL_CALLS = 1_793;
const HEADING_COUNT = 1_089;
const CODE_FENCE_MARKERS = 490;
const HTML_TAG_COUNT = 7_537;
const MAX_STRESS_LINE = 20_166;

const outputPath = resolve(
  process.cwd(),
  process.argv[2] || "tmp/fixtures/history_202605071054.generated.md",
);

const lines = [
  "# CodeBuddy Chat Conversation",
  "_Generated privacy-safe performance fixture for nowen-note._",
  "",
  "**User**",
  "",
  "<user_info>",
  "OS Version: win32",
  "Shell: PowerShell",
  "Workspace Folder: c:/UGit/nowen-note",
  "</user_info>",
  "",
];

let headingMarkers = 1;
let htmlTags = 2;
let fenceMarkers = 0;

for (let index = 0; index < TOOL_CALLS; index += 1) {
  if (headingMarkers < HEADING_COUNT) {
    lines.push(`## Interaction ${index + 1}`);
    headingMarkers += 1;
  } else {
    lines.push("**CodeBuddy**");
  }
  lines.push("🔧 **Tool Call**: replace_in_file");
  lines.push(
    `Arguments: {"filePath":"c:/UGit/nowen-note/frontend/src/components/Fixture${index % 37}.tsx","old_str":"${"old-value-".repeat(16)}","new_str":"${"new-value-".repeat(18)}"}`,
  );
  lines.push(`<tool_result id="${index}">ok</tool_result>`);
  htmlTags += 2;

  if (fenceMarkers < CODE_FENCE_MARKERS && index % 7 === 0) {
    lines.push("```tsx");
    lines.push(`export const value${index} = ${index};`);
    lines.push("```");
    fenceMarkers += 2;
  }
}

while (headingMarkers < HEADING_COUNT) {
  lines.push(`### Generated heading ${headingMarkers + 1}`);
  headingMarkers += 1;
}

while (htmlTags < HTML_TAG_COUNT) {
  lines.push(`<trace index="${htmlTags}">frame</trace>`);
  htmlTags += 2;
}
if (htmlTags > HTML_TAG_COUNT) {
  lines.push("<trace>");
  htmlTags -= 1;
}

while (fenceMarkers < CODE_FENCE_MARKERS) {
  lines.push("```");
  fenceMarkers += 1;
}

// Add representative very long JSON/tool lines without any real credentials.
for (let index = 0; index < 10; index += 1) {
  const prefix = `Arguments: {"stressLine":${index},"content":"`;
  const suffix = `"}`;
  lines.push(prefix + "x".repeat(MAX_STRESS_LINE - prefix.length - suffix.length) + suffix);
}

// Reserve the final line for deterministic byte padding.
while (lines.length < TARGET_LINES - 1) {
  lines.push("");
}
if (lines.length > TARGET_LINES - 1) {
  throw new Error(`Fixture structure exceeded target line count: ${lines.length + 1}`);
}

lines.push("");

let output = lines.join("\n");
let currentBytes = Buffer.byteLength(output, "utf8");
if (currentBytes > TARGET_BYTES) {
  throw new Error(`Fixture exceeded target byte size: ${currentBytes}`);
}

let remaining = TARGET_BYTES - currentBytes;
let cursor = TARGET_LINES - 2;
while (remaining > 0 && cursor >= 0) {
  const room = Math.max(0, MAX_STRESS_LINE - lines[cursor].length);
  const add = Math.min(room, remaining);
  if (add > 0) {
    lines[cursor] += "p".repeat(add);
    remaining -= add;
  }
  cursor -= 1;
}
if (remaining > 0) {
  throw new Error(`Unable to pad fixture by ${remaining} bytes within line-length budget`);
}

output = lines.join("\n");
const actualBytes = Buffer.byteLength(output, "utf8");
const actualLines = output.split("\n").length;

if (actualBytes !== TARGET_BYTES || actualLines !== TARGET_LINES) {
  throw new Error(
    `Fixture mismatch: ${actualBytes} bytes / ${actualLines} lines`,
  );
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, "utf8");

console.info(
  JSON.stringify(
    {
      outputPath,
      bytes: actualBytes,
      lines: actualLines,
      toolCalls: (output.match(/🔧 \*\*Tool Call\*\*/g) || []).length,
      codeFenceMarkers: (output.match(/```/g) || []).length,
      headings: output.split("\n").filter((line) => /^#{1,6}\s/.test(line)).length,
      maxLineLength: Math.max(...output.split("\n").map((line) => line.length)),
    },
    null,
    2,
  ),
);
