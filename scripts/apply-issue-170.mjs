import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const sidebarPath = path.resolve(process.cwd(), "frontend/src/components/Sidebar.tsx");
const source = fs.readFileSync(sidebarPath, "utf8");
const importAnchor = 'import CreateNoteMenu, { type NoteType } from "@/components/CreateNoteMenu";';
const pickerImport = 'import EmojiIconPicker from "@/components/EmojiPicker";';
const pickerStart = "/* ===== Emoji 图标选择器 ===== */";
const nextSection = "/* ===== 移动笔记本：树形选择器条目 ===== */";

if (!source.includes(importAnchor)) {
  throw new Error(`Sidebar import anchor not found: ${importAnchor}`);
}

const startIndex = source.indexOf(pickerStart);
const endIndex = source.indexOf(nextSection);
if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
  throw new Error("Legacy emoji picker block was not found or has changed");
}

let next = source;
if (!next.includes(pickerImport)) {
  next = next.replace(importAnchor, `${importAnchor}\n${pickerImport}`);
}

const adjustedStart = next.indexOf(pickerStart);
const adjustedEnd = next.indexOf(nextSection);
next = `${next.slice(0, adjustedStart)}${next.slice(adjustedEnd)}`;

if (next.includes("const EMOJI_GROUPS") || next.includes("function EmojiIconPicker")) {
  throw new Error("Legacy emoji picker declarations remain after codemod");
}
if (!next.includes(pickerImport) || !next.includes("<EmojiIconPicker")) {
  throw new Error("Standalone EmojiPicker was not wired into Sidebar");
}

fs.writeFileSync(sidebarPath, next, "utf8");
console.log("Issue #170: Sidebar now uses the standalone EmojiPicker component.");
