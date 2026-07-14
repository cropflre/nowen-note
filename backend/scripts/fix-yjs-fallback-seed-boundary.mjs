import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(here, "../src/services/yjs.ts");
let source = fs.readFileSync(filePath, "utf8");
const from = `      const note = db.prepare("SELECT content, contentText FROM notes WHERE id = ?").get(noteId) as
        | { content: string; contentText: string }
        | undefined;`;
const to = `      const note = yjsPersistenceRepository.getNoteSeed(noteId);`;
if (!source.includes(from)) {
  throw new Error("missing Yjs fallback seed query fragment");
}
source = source.replace(from, to);
fs.writeFileSync(filePath, source);
console.log("Moved Yjs fallback seed lookup behind repository.");
