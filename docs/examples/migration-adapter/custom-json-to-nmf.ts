/** Offline example: run from backend with node --import tsx ../docs/examples/migration-adapter/custom-json-to-nmf.ts input.json output-directory */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MIGRATION_LIMITS, nmfManifestSchema, nmfNoteSchema, type NmfNote } from "../../../backend/src/services/migrationFormat";

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid example export fields");
  return value as Record<string, unknown>;
}

/** Replace this source parser for another authorized export, keeping NMF validation. */
export function normalizeCustomExport(input: unknown): NmfNote[] {
  const data = record(input, ["format", "version", "exportId", "notes"]);
  if (data.format !== "custom-notes-example" || data.version !== 1 || !Array.isArray(data.notes)
    || !data.notes.length || data.notes.length > MIGRATION_LIMITS.notes) throw new Error("Unsupported or empty example export");
  const seen = new Set<string>();
  return data.notes.map((value) => {
    const entry = record(value, ["id", "title", "text", "path", "tags"]);
    const note = nmfNoteSchema.parse({ schemaVersion: 1, source: { platform: "custom-example", exportId: data.exportId, sourceId: entry.id },
      title: entry.title, contentFormat: "txt", content: entry.text, path: entry.path, tags: entry.tags });
    if (seen.has(note.source.sourceId)) throw new Error("Duplicate example source ID");
    seen.add(note.source.sourceId);
    return note;
  });
}

export function writeCustomNmf(inputPath: string, outputPath: string): void {
  const stat = fs.lstatSync(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MIGRATION_LIMITS.contentBytes) throw new Error("Example input must be a regular UTF-8 JSON file of at most 2MiB");
  const notes = normalizeCustomExport(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(inputPath))));
  const manifest = nmfManifestSchema.parse({ format: "nowen-migration", schemaVersion: 1,
    source: { platform: "custom-example", exportId: notes[0].source.exportId },
    notes: notes.map((note, index) => {
      const { schemaVersion: _schema, source, content, ...fields } = note;
      return { ...fields, sourceId: source.sourceId, contentFile: `notes/${index + 1}.txt`, sha256: crypto.createHash("sha256").update(content).digest("hex") };
    }) });
  // mkdir without recursive refuses an existing destination. Source data is never changed.
  fs.mkdirSync(outputPath, { mode: 0o700 });
  try {
    fs.mkdirSync(path.join(outputPath, "notes"), { mode: 0o700 });
    notes.forEach((note, index) => fs.writeFileSync(path.join(outputPath, manifest.notes[index].contentFile), note.content, { flag: "wx", mode: 0o600 }));
    fs.writeFileSync(path.join(outputPath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) { fs.rmSync(outputPath, { recursive: true, force: true }); throw error; }
}

if (require.main === module) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || process.argv.length !== 4) {
    console.error("Usage: custom-json-to-nmf.ts input.json new-output-directory"); process.exitCode = 1;
  } else {
    try { writeCustomNmf(inputPath, outputPath); console.log("NMF package prepared. ZIP manifest.json and notes/ at the archive root, then upload and review in Nowen Note."); }
    catch { console.error("Conversion failed. Check the example format, size and a new destination directory. Source data was not changed."); process.exitCode = 1; }
  }
}
