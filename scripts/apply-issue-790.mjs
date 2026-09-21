import { readFileSync, writeFileSync } from "node:fs";

// One-off follow-up to the verified editor integration. Refuse unexpected source shapes.
const path = "frontend/src/components/EditorPane.tsx";
const original = readFileSync(path, "utf8");
const buttonBefore = "disabled={effectiveLocked || isTrashed || noteIsFullHtmlDoc}";
const buttonAfter = "disabled={effectiveLocked || isTrashed || noteIsFullHtmlDoc || !canEditActiveNote}";
const dialogBefore = "open={showMindMapInsertDialog && !!activeNote && !effectiveLocked && !isTrashed && !noteIsFullHtmlDoc}";
const dialogAfter = "open={showMindMapInsertDialog && !!activeNote && !effectiveLocked && !isTrashed && !noteIsFullHtmlDoc && canEditActiveNote}";
const insertBefore = "if (!activeNote || effectiveLocked || isTrashed || noteIsFullHtmlDoc) return false;";
const insertAfter = "if (!activeNote || effectiveLocked || isTrashed || noteIsFullHtmlDoc || !canEditActiveNote) return false;";
const count = (source, needle) => source.split(needle).length - 1;
if (count(original, buttonBefore) === 0 && count(original, buttonAfter) === 2 && original.includes(dialogAfter) && original.includes(insertAfter)) {
  console.log("Issue #790 note permission guards already integrated");
} else {
  if (count(original, buttonBefore) !== 2 || count(original, dialogBefore) !== 1 || count(original, insertBefore) !== 1 || !original.includes("const canEditActiveNote = canWriteNote(activeNote);")) {
    throw new Error("Issue #790 note permission anchors are missing or ambiguous");
  }
  const updated = original.replaceAll(buttonBefore, buttonAfter)
    .replace(dialogBefore, dialogAfter)
    .replace(insertBefore, insertAfter);
  writeFileSync(path, updated);
  console.log(`Updated ${path}: disabled insertion for read-only notes`);
}
