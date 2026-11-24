import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { MIGRATION_LIMITS, nmfNoteSchema, nmfManifestSchema } from "../src/services/migrationFormat";
import { stageMigrationFile } from "../src/services/migrationSourceAdapter";

const source = { platform: "files", exportId: "export-1" };
const logical = { schemaVersion: 1, source: { ...source, sourceId: "note-1" }, title: "Title", contentFormat: "markdown", content: "# Test" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYZkAAAAASUVORK5CYII=", "base64");
const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");

async function withArchive(zip: JSZip, run: (input: Parameters<typeof stageMigrationFile>[0], notes: any[]) => Promise<void>) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-source-"));
  const uploadDir = path.join(jobDir, "sources", "upload-1");
  fs.mkdirSync(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, "source.zip");
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" }));
  const notes: any[] = [];
  try { await run({ filePath, filename: "source.zip", jobDir, source, onNote: async (note) => { notes.push(note); } }, notes); }
  finally { fs.rmSync(jobDir, { recursive: true, force: true }); }
}

test("NMF v1 freezes bounded fields, strips no unknown properties, and normalizes UTC", () => {
  const parsed = nmfNoteSchema.parse({ ...logical, createdAt: "2025-01-01T18:00:00+08:00" });
  assert.equal(parsed.createdAt, "2025-01-01T10:00:00.000Z");
  assert.deepEqual(parsed.tags, []);
  assert.equal(nmfNoteSchema.safeParse({ ...logical, schemaVersion: 2 }).success, false);
  assert.equal(nmfNoteSchema.safeParse({ ...logical, userId: "other-user" }).success, false);
  assert.equal(nmfNoteSchema.safeParse({ ...logical, source: { ...logical.source, internalId: "injected" } }).success, false);
  assert.equal(nmfNoteSchema.safeParse({ ...logical, content: "汉".repeat(Math.ceil(MIGRATION_LIMITS.contentBytes / 3)) }).success, false);
  assert.equal(nmfNoteSchema.safeParse({ ...logical, metadata: { nested: { secret: true } } }).success, false);
  assert.equal(nmfNoteSchema.safeParse({ ...logical, metadata: JSON.parse('{"__proto__":"bad"}') }).success, false);
  for (const unsafe of ["../secret.png", "/etc/passwd", "C:/secret.png", "assets\\secret.png", "assets/./image.png"]) {
    assert.equal(nmfNoteSchema.safeParse({ ...logical, attachments: [{ assetId: "a", path: unsafe, sha256: "a".repeat(64) }] }).success, false);
  }
});

test("Markdown + local images ZIP produces stable NMF paths, hashes, directories and internal links", async () => {
  const zip = new JSZip();
  zip.file("Work/a.md", "# Alpha\n![Image](../assets/image.png)\n[Beta](b.md#target)\n[External](https://example.com/)");
  zip.file("Work/b.md", "# Beta\n");
  zip.file("assets/image.png", png);
  await withArchive(zip, async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.equal(notes.length, 2);
    assert.deepEqual(notes[0].path, ["Work"]);
    assert.equal(notes[0].attachments[0].sha256, hash(png));
    assert.equal(notes[0].attachments[0].originalPath, "../assets/image.png");
    assert.equal(notes[0].attachments[0].path, "sources/upload-1/extracted/assets/image.png");
    assert.deepEqual(notes[0].links, [{ href: "b.md#target", targetSourceId: "Work/b.md" }]);
    assert.ok(result.warnings.some((warning) => warning.startsWith("EXTERNAL_RESOURCES")));
    const first = JSON.stringify(notes);
    notes.length = 0;
    await stageMigrationFile(input);
    assert.equal(JSON.stringify(notes), first, "restarting scan must not change item identities");
  });
});

test("Obsidian vaults keep embedded images and note links, read front matter and leave code and settings alone", async () => {
  const zip = new JSZip();
  zip.file("Vault/Daily/2024-01-01.md", [
    "---", "title: New year", "tags: [daily, \"#journal\"]", "created: 2024-01-01 08:00:00Z", "updated: 2024-01-02T09:30+08:00", "---",
    "# Heading", "![[Pasted image.png]]", "![[photo.png|300]]", "See [[Projects/Plan|the plan]] and [[Plan#Goals]].",
    "Missing [[Nowhere]] and ![[missing.png]].", "Inline `![[Pasted image.png]]` stays.", "```js", "const link = \"[[Plan]]\";", "```", "",
  ].join("\n"));
  zip.file("Vault/attachments/Pasted image.png", png);
  zip.file("Vault/photo.png", png);
  zip.file("Vault/Projects/Plan.md", "---\ncreated: 2024-03-01 10:00\n---\n# Plan\n## Goals\n");
  zip.file("Vault/.obsidian/workspace.json", "{}");
  zip.file("Vault/.obsidian/plugins/x/main.js", "alert(1)");
  zip.file("Vault/.trash/Deleted.md", "# Deleted");
  zip.file("Vault/.DS_Store", "x");
  await withArchive(zip, async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.deepEqual(notes.map((note) => note.source.sourceId), ["Vault/Daily/2024-01-01.md", "Vault/Projects/Plan.md"]);
    const [daily, plan] = notes;
    assert.equal(daily.title, "New year");
    assert.deepEqual(daily.tags, ["daily", "journal"]);
    assert.equal(daily.createdAt, "2024-01-01T08:00:00.000Z");
    assert.equal(daily.updatedAt, "2024-01-02T01:30:00.000Z");
    // Embeds become standard images, links point at the imported note; everything else is untouched.
    assert.match(daily.content, /!\[Pasted image\.png\]\(<\.\.\/attachments\/Pasted image\.png>\)/);
    assert.match(daily.content, /!\[photo\.png\]\(<\.\.\/photo\.png>\)/);
    assert.match(daily.content, /See \[the plan\]\(<\.\.\/Projects\/Plan\.md>\) and \[Plan > Goals\]\(<\.\.\/Projects\/Plan\.md>\)\./);
    assert.match(daily.content, /Missing \[\[Nowhere\]\] and !\[\[missing\.png\]\]\./);
    assert.match(daily.content, /Inline `!\[\[Pasted image\.png\]\]` stays\./);
    assert.match(daily.content, /const link = "\[\[Plan\]\]";/);
    assert.ok(daily.content.startsWith("---\ntitle: New year\n"), "front matter stays in the note");
    assert.deepEqual(daily.attachments.map((asset: any) => [asset.originalPath, asset.sha256]), [["../attachments/Pasted image.png", hash(png)], ["../photo.png", hash(png)]]);
    assert.deepEqual(daily.links, [{ href: "../Projects/Plan.md", targetSourceId: "Vault/Projects/Plan.md" }]);
    // A time without an offset would be a guess, so it is not used.
    assert.equal(plan.title, "Plan");
    assert.equal(plan.createdAt, undefined);
    assert.ok(result.warnings.some((warning) => warning.startsWith("UNRESOLVED_RELATIVE_REFERENCES")), "a missing embedded image is reported");
    assert.ok(!result.warnings.some((warning) => warning.startsWith("UNSUPPORTED_FILES_SKIPPED")), "app settings are not reported as skipped content");
  });
});

test("Logseq settings, backups and recycled pages are not imported as notes", async () => {
  const zip = new JSZip();
  zip.file("logseq/config.edn", "{}");
  zip.file("logseq/custom.css", "body{}");
  zip.file("logseq/bak/pages/Home/2024.md", "- old copy");
  zip.file("pages/Home.md", "- [[Ideas]]");
  zip.file("pages/Ideas.md", "- idea");
  zip.file("journals/2024_01_01.md", "- today");
  await withArchive(zip, async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.deepEqual(notes.map((note) => note.source.sourceId), ["journals/2024_01_01.md", "pages/Home.md", "pages/Ideas.md"]);
    assert.equal(notes[1].content, "- [Ideas](<Ideas.md>)");
    assert.ok(!result.warnings.some((warning) => warning.startsWith("UNSUPPORTED_FILES_SKIPPED")));
  });
});

test("NMF offline package validates body and asset hashes before emitting any note", async () => {
  const body = "<h1>Hello</h1><script>steal()</script><img src=\"../assets/image.png\" onerror=\"steal()\">";
  const manifest = nmfManifestSchema.parse({ format: "nowen-migration", schemaVersion: 1, source,
    notes: [{ sourceId: "html-1", title: "HTML", path: ["Folder"], contentFormat: "html", contentFile: "notes/one.html", sha256: hash(body),
      attachments: [{ assetId: "image", path: "assets/image.png", sha256: hash(png) }], metadata: { unsupportedProperty: "preserved in report only" } }] });
  const zip = new JSZip().file("manifest.json", JSON.stringify(manifest)).file("notes/one.html", body).file("assets/image.png", png);
  await withArchive(zip, async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.equal(notes.length, 1);
    assert.doesNotMatch(notes[0].content, /script|onerror|steal/);
    assert.equal(notes[0].attachments[0].originalPath, "../assets/image.png");
    assert.ok(result.warnings.some((warning) => warning.startsWith("SOURCE_METADATA")));
  });
  zip.file("assets/image.png", Buffer.from("tampered"));
  await withArchive(zip, async (input, notes) => {
    await assert.rejects(stageMigrationFile(input), /MIGRATION_ASSET_HASH_MISMATCH/);
    assert.equal(notes.length, 0);
  });
});

test("ZIP rejects traversal, symlinks, case collisions and decompression bombs before notes are emitted", async () => {
  const examples = [
    new JSZip().file("../escaped.md", "# escape"),
    new JSZip().file("link.md", "../../outside", { unixPermissions: 0o120777 }),
    new JSZip().file("A.md", "A").file("a.md", "a"),
    new JSZip().file("huge.md", "x".repeat(MIGRATION_LIMITS.contentBytes + 1)),
    new JSZip().file("assets/bomb.pdf", Buffer.alloc(4 * 1024 * 1024)),
  ];
  for (const zip of examples) await withArchive(zip, async (input, notes) => {
    await assert.rejects(stageMigrationFile(input), /MIGRATION_(?:UNSAFE|ARCHIVE)/);
    assert.equal(notes.length, 0);
  });
});

test("HTML is sanitized and remote/private-network resources are never fetched", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("network forbidden"); };
  try {
    const zip = new JSZip().file("one.html", '<h1>Import</h1><img src="http://169.254.169.254/latest/meta-data"><a href="javascript:alert(1)">bad</a><iframe src="file:///etc/passwd"></iframe>');
    await withArchive(zip, async (input, notes) => {
      const result = await stageMigrationFile(input);
      assert.equal(notes.length, 1);
      assert.doesNotMatch(notes[0].content, /javascript:|iframe|file:/);
      assert.ok(result.warnings.some((warning) => warning.startsWith("EXTERNAL_RESOURCES")));
      assert.equal(calls, 0);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("Spoofed asset MIME is rejected and unsupported files are reported", async () => {
  const unsafe = new JSZip().file("one.md", "![bad](assets/image.png)").file("assets/image.png", "<script>bad()</script>");
  await withArchive(unsafe, async (input) => { await assert.rejects(stageMigrationFile(input), /MIGRATION_ASSET_TYPE_MISMATCH/); });
  const skipped = new JSZip().file("one.md", "# one").file("macro.docm", "macro").file("database.csv", "a,b");
  await withArchive(skipped, async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.equal(notes.length, 1);
    assert.ok(result.warnings.some((warning) => warning.startsWith("UNSUPPORTED_FILES")));
    assert.ok(result.warnings.some((warning) => warning.startsWith("CSV_DATABASE")));
  });
});

test("the checked-in NMF example follows the frozen manifest and byte hashes", async () => {
  const root = path.resolve(__dirname, "../../docs/examples/migration");
  const manifest = nmfManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")));
  const zip = new JSZip().file("manifest.json", JSON.stringify(manifest));
  for (const item of manifest.notes) {
    const body = fs.readFileSync(path.join(root, item.contentFile));
    assert.equal(hash(body), item.sha256);
    zip.file(item.contentFile, body);
  }
  await withArchive(zip, async (input, notes) => {
    await stageMigrationFile(input);
    assert.equal(notes.length, manifest.notes.length);
    assert.equal(notes[0].source.exportId, "nmf-v1-example");
  });
});

test("safe ZIP ingestion dispatches Notion fixtures into stable IDs and cleaned paths", async () => {
  const root = path.join(__dirname, "fixtures/migration-notion");
  const zip = new JSZip();
  const add = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) add(filename);
      else if (!filename.endsWith("README.md")) zip.file(path.relative(root, filename).split(path.sep).join("/"), fs.readFileSync(filename));
    }
  };
  add(root);
  await withArchive(zip, async (input, notes) => {
    const result = await stageMigrationFile(input);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].source.platform, "notion");
    assert.ok(notes.every((note) => /^[a-f0-9]{32}$/.test(note.source.sourceId)));
    assert.deepEqual(notes[0].path, ["Workspace", "Projects"]);
    assert.ok(result.warnings.some((warning) => warning.includes("NOTION")));
    assert.ok(notes.some((note) => note.links.some((link: any) => link.targetSourceId === "4".repeat(32))));
  });
});

test("safe ZIP ingestion dispatches native Siyuan documents and local assets through the same NMF callback", async () => {
  const zip = new JSZip().file("data/box/.siyuan/conf.json", JSON.stringify({ name: "Knowledge" }))
    .file("data/box/one.sy", JSON.stringify({ ID: "one", Type: "NodeDocument", Properties: { title: "One" }, Children: [
      { Type: "NodeParagraph", Children: [{ Type: "NodeText", Data: "Imported body" }] },
      { Type: "NodeImage", Children: [{ Type: "NodeLinkDest", Data: "assets/image.png" }] },
    ] })).file("data/assets/image.png", png);
  await withArchive(zip, async (input, notes) => {
    await stageMigrationFile(input);
    assert.equal(notes.length, 1); assert.equal(notes[0].source.platform, "siyuan");
    assert.equal(notes[0].source.sourceId, "one"); assert.deepEqual(notes[0].path, ["Knowledge"]);
    assert.match(notes[0].content, /Imported body/); assert.equal(notes[0].attachments.length, 1);
    assert.equal(notes[0].attachments[0].sha256, hash(png));
    assert.match(notes[0].attachments[0].path, /^sources\/upload-1\/extracted\//);
  });
});
