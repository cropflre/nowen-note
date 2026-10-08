/**
 * Read-only audit. From backend/:
 * npm run inspect:note-formats -- --db="D:\\path\\nowen-note.db" --limit=30
 * No writes, no migrations, never prints note contents.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { diagnoseTiptapContent, type TiptapContentDiagnosis } from "../src/lib/tiptap-note-format";

const args = process.argv.slice(2);
const dbArg = args.find((item) => item.startsWith("--db="))?.slice(5);
const limitArg = args.find((item) => item.startsWith("--limit="))?.slice(8);
const limit = limitArg === undefined ? 30 : Number(limitArg);
if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
  throw new Error("--limit must be an integer between 0 and 500");
}
const dbPath = path.resolve(dbArg || process.env.DB_PATH || path.join(process.cwd(), "data", "nowen-note.db"));
if (!fs.existsSync(dbPath)) throw new Error("Database file not found. Pass --db=<path>.");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
type Row = { id: string; content: string | null; version: number };
const counts: Record<TiptapContentDiagnosis, number> = {
  valid: 0, "html-markup": 0, "invalid-json": 0, "invalid-doc": 0,
};
const examples: Array<{ noteId: string; version: number; reason: TiptapContentDiagnosis }> = [];
try {
  const rows = db.prepare("SELECT id, content, version FROM notes WHERE contentFormat = 'tiptap-json'");
  for (const row of rows.iterate() as Iterable<Row>) {
    const reason = diagnoseTiptapContent(row.content || "");
    counts[reason] += 1;
    if (reason !== "valid" && examples.length < limit) examples.push({
      noteId: row.id, version: row.version, reason,
    });
  }
} finally { db.close(); }
console.log(JSON.stringify({
  readOnly: true, autoRepair: false,
  inspected: Object.values(counts).reduce((sum, value) => sum + value, 0),
  counts, examples,
}, null, 2));
