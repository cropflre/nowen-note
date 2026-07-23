import { readFileSync, writeFileSync } from "node:fs";

const path = "backend/src/services/embedding-worker.ts";
const source = readFileSync(path, "utf8");
const start = source.indexOf("interface EmbeddingConfig {");
const endMarker = "\n// ============================================================\n// 文本切分（粗略版）";
const end = source.indexOf(endMarker, start);

if (start < 0) {
  console.log("Legacy embedding config resolver already removed.");
} else {
  if (end < 0) throw new Error("Legacy embedding config resolver end marker not found");
  writeFileSync(path, source.slice(0, start) + source.slice(end));
  console.log("Legacy embedding config resolver removed.");
}
