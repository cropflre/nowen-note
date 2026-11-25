import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { nmfNoteSchema, type NmfNote } from "../src/services/migrationFormat";
import { stageMigrationFile } from "../src/services/migrationSourceAdapter";
import { MIGRATION_SOURCE_ADAPTERS, MIGRATION_SOURCE_ADAPTER_API_VERSION, normalizeMigrationSource, type MigrationSourceAdapterContext, type MigrationSourceAdapter } from "../src/services/migrationSourceAdapters";

const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const example = nmfNoteSchema.parse({ schemaVersion: 1, source: { platform: "files", exportId: "adapter-v1", sourceId: "example" }, title: "Example", contentFormat: "txt", content: "Authorized text" });
function context(notes: NmfNote[]): MigrationSourceAdapterContext {
  return { source: { platform: "files", exportId: "adapter-v1" }, files: new Map(), readText: () => { throw new Error("not used"); },
    managedPath: () => { throw new Error("not used"); }, sniffAsset: async () => { throw new Error("not used"); }, onNote: async (note) => { notes.push(note); } };
}
async function archive(zip: JSZip, platform: string, check: (input: Parameters<typeof stageMigrationFile>[0], notes: NmfNote[]) => Promise<void>) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-adapter-contract-"));
  const filePath = path.join(jobDir, "source.zip");
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const notes: NmfNote[] = [];
  try { await check({ filePath, jobDir, filename: "source.zip", source: { platform, exportId: "adapter-v1" }, onNote: async (note) => { notes.push(note); } }, notes); }
  finally { fs.rmSync(jobDir, { recursive: true, force: true }); }
}

test("source adapter catalog has unique versioned built-ins and explicit Huawei identification", () => {
  assert.equal(MIGRATION_SOURCE_ADAPTER_API_VERSION, 1);
  assert.equal(new Set(MIGRATION_SOURCE_ADAPTERS.map((adapter) => adapter.id)).size, MIGRATION_SOURCE_ADAPTERS.length);
  for (const adapter of MIGRATION_SOURCE_ADAPTERS) {
    assert.equal(adapter.version, 1); assert.ok(adapter.extensions.length); assert.ok(adapter.unsupported.length);
  }
  const huawei = MIGRATION_SOURCE_ADAPTERS.find((adapter) => adapter.id === "huawei-notepad-files")!;
  assert.equal(huawei.autoDetect, false); assert.deepEqual(huawei.platforms, ["huawei"]);
});

test("trusted adapter contract selects the first match and validates NMF before emitting", async () => {
  const notes: NmfNote[] = [], called: string[] = [];
  const adapters: MigrationSourceAdapter[] = [
    { apiVersion: 1, id: "nmf-v1", matches: () => false, normalize: async () => { throw new Error("must not run"); } },
    { apiVersion: 1, id: "generic-files", matches: () => true, normalize: async (ctx) => { called.push("generic"); await ctx.onNote(example); return { warnings: [] }; } },
    { apiVersion: 1, id: "huawei-notepad-files", matches: () => true, normalize: async () => { throw new Error("later match must not run"); } },
  ];
  await normalizeMigrationSource(adapters, context(notes));
  assert.deepEqual(called, ["generic"]); assert.equal(notes.length, 1);
  adapters[1].normalize = async (ctx) => { await ctx.onNote({ ...example, userId: "injected-owner" } as NmfNote); return { warnings: [] }; };
  notes.length = 0;
  await assert.rejects(normalizeMigrationSource(adapters, context(notes)));
  assert.equal(notes.length, 0);
  await assert.rejects(normalizeMigrationSource([{ ...adapters[1], apiVersion: 2 } as unknown as MigrationSourceAdapter], context(notes)), /MIGRATION_ADAPTER_VERSION_UNSUPPORTED/);
  await assert.rejects(normalizeMigrationSource(adapters, { ...context(notes), assertActive: () => { throw new Error("cancelled"); } }), /cancelled/);
});

test("NMF manifest takes precedence over unrelated native-format files", async () => {
  const body = "Explicit source package";
  const zip = new JSZip().file("manifest.json", JSON.stringify({ format: "nowen-migration", schemaVersion: 1, source: { platform: "custom", exportId: "adapter-v1" },
    notes: [{ sourceId: "manifest-wins", title: "Manifest", contentFormat: "txt", contentFile: "notes/one.txt", sha256: hash(body) }] }))
    .file("notes/one.txt", body).file("notebook/invalid.sy", "not valid Siyuan JSON");
  await archive(zip, "files", async (input, notes) => { await stageMigrationFile(input); assert.equal(notes.length, 1); assert.equal(notes[0].source.platform, "custom"); });
});

test("the host enforces the note limit even when a trusted adapter emits more notes", async () => {
  let emitted = 0;
  const adapter: MigrationSourceAdapter = { apiVersion: 1, id: "generic-files", matches: () => true, normalize: async (ctx) => {
    for (let index = 0; index <= 10_000; index++) await ctx.onNote(example);
    return { warnings: [] };
  } };
  await assert.rejects(normalizeMigrationSource([adapter], { ...context([]), onNote: async () => { emitted++; } }), /MIGRATION_NOTE_COUNT_LIMIT/);
  assert.equal(emitted, 10_000);
});

test("explicit Huawei TXT and HTML exports reuse safe local resource mapping without guessing metadata", async () => {
  const pdf = Buffer.from("%PDF-1.7\nSynthetic local attachment");
  const zip = new JSZip().file("NotePad/会议.txt", "原样保留纯文本\n第二行")
    .file("NotePad/资料.html", '<title>资料</title><p>本地资料</p><a href="../assets/document.pdf">PDF</a><script>ignore()</script>')
    .file("assets/document.pdf", pdf);
  await archive(zip, "huawei", async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.equal(notes.length, 2); assert.ok(notes.every((note) => note.source.platform === "huawei"));
    const text = notes.find((note) => note.contentFormat === "txt")!, html = notes.find((note) => note.contentFormat === "html")!;
    assert.equal(text.content, "原样保留纯文本\n第二行"); assert.deepEqual(text.path, ["NotePad"]);
    assert.equal(text.createdAt, undefined); assert.deepEqual(text.tags, []);
    assert.doesNotMatch(html.content, /script|ignore/); assert.equal(html.attachments[0].sha256, hash(pdf));
    assert.ok(result.warnings.some((warning) => warning.startsWith("HUAWEI_EXPORT_LIMITS")));
  });
  await archive(new JSZip().file("note.md", "# Not an official Huawei TXT/HTML input"), "huawei", async (input, notes) => {
    await assert.rejects(stageMigrationFile(input), /MIGRATION_HUAWEI_FORMAT_UNSUPPORTED/); assert.equal(notes.length, 0);
  });
  await archive(new JSZip().file("NotePad/plain.txt", "Same generic bytes"), "files", async (input, notes) => {
    const result = await stageMigrationFile(input); assert.equal(notes[0].source.platform, "files");
    assert.ok(!result.warnings.some((warning) => warning.startsWith("HUAWEI_")), "filenames do not prove vendor identity");
  });
});

test("the offline custom adapter example produces an importable NMF package and refuses overwrites", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-custom-adapter-"));
  const exampleRoot = path.resolve(__dirname, "../../docs/examples/migration-adapter");
  const inputPath = path.join(exampleRoot, "input.json"), output = path.join(directory, "package");
  const script = path.join(exampleRoot, "custom-json-to-nmf.ts"), before = hash(fs.readFileSync(inputPath));
  try {
    const convert = () => spawnSync(process.execPath, ["--import", "tsx", script, inputPath, output], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    const result = convert(); assert.equal(result.status, 0, result.stderr);
    assert.equal(convert().status, 1, "an existing output directory is never overwritten");
    assert.equal(hash(fs.readFileSync(inputPath)), before);
    const zip = new JSZip().file("manifest.json", fs.readFileSync(path.join(output, "manifest.json")));
    for (const name of fs.readdirSync(path.join(output, "notes"))) zip.file(`notes/${name}`, fs.readFileSync(path.join(output, "notes", name)));
    await archive(zip, "files", async (input, notes) => {
      await stageMigrationFile(input); assert.equal(notes.length, 1);
      assert.equal(notes[0].source.platform, "custom-example"); assert.equal(notes[0].source.sourceId, "source-note-001");
      assert.deepEqual(notes[0].tags, ["migration-example"]); assert.match(notes[0].content, /Instructions inside a note remain data/);
    });
    const { normalizeCustomExport } = await import("../../docs/examples/migration-adapter/custom-json-to-nmf");
    const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    assert.throws(() => normalizeCustomExport({ ...raw, serverPath: "/private/notes" }), /Invalid example export fields/);
    assert.throws(() => normalizeCustomExport({ ...raw, notes: [raw.notes[0], raw.notes[0]] }), /Duplicate example source ID/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
