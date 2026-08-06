import fs from "node:fs";

const file = "frontend/src/components/NoteImageExportCenter.tsx";
let source = fs.readFileSync(file, "utf8");
const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*"@\/lib\/noteImageExportBridge";/;
const match = source.match(importPattern);

if (!match) {
  throw new Error("noteImageExportBridge import block not found");
}

if (!match[1].includes("setNoteImageExportCenterReady")) {
  const names = match[1].trimEnd();
  source = source.replace(
    importPattern,
    `import {${names},\n  setNoteImageExportCenterReady,\n} from "@/lib/noteImageExportBridge";`,
  );
}

fs.writeFileSync(file, source);
console.log("Ensured NoteImageExportCenter imports setNoteImageExportCenterReady");
