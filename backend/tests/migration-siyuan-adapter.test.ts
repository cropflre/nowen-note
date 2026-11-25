import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MIGRATION_LIMITS, type NmfNote } from "../src/services/migrationFormat";
import { isSiyuanMigration, stageSiyuanMigration, type SiyuanMigrationInput, type SiyuanMigrationFile } from "../src/services/migrationSiyuanAdapter";
import { sniffMigrationAsset } from "../src/services/migrationSourceAdapter";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYZkAAAAASUVORK5CYII=", "base64");
const paragraph = (children: unknown[]) => ({ Type: "NodeParagraph", Children: children });
const text = (Data: string) => ({ Type: "NodeText", Data });
const image = (src: string) => ({ Type: "NodeImage", Children: [{ Type: "NodeLinkText", Data: "Image" }, { Type: "NodeLinkDest", Data: src }] });
const sy = (ID: string, title: string, Children: unknown[] = [], properties: Record<string, unknown> = {}) => JSON.stringify({ ID, Type: "NodeDocument", Properties: { title, ...properties }, Children });

async function fixture(entries: Record<string, string | Buffer>, run: (input: SiyuanMigrationInput, notes: NmfNote[], reads: string[]) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-siyuan-"));
  const files = new Map<string, SiyuanMigrationFile>(), notes: NmfNote[] = [], reads: string[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const diskPath = path.join(directory, name); fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, buffer);
    files.set(name, { diskPath, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") });
  }
  const input: SiyuanMigrationInput = {
    files, source: { platform: "files", exportId: "siyuan-export" },
    readText(name, maxBytes) {
      assert.ok(maxBytes <= MIGRATION_LIMITS.contentBytes); reads.push(name);
      const file = files.get(name)!; if (file.size > maxBytes) throw new Error("fixture exceeded read budget");
      return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file.diskPath));
    },
    managedPath: (file) => path.relative(directory, file.diskPath).split(path.sep).join("/"),
    sniffAsset: sniffMigrationAsset,
    onNote: async (note) => { notes.push(note); },
  };
  try { await run(input, notes, reads); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("Siyuan adapter preserves source IDs, hierarchy, tags, explicit times and asset aliases through pure NMF", async () => {
  await fixture({
    "data/box/.siyuan/conf.json": JSON.stringify({ name: "Knowledge" }),
    "data/box/parent.sy": sy("parent", "Parent"),
    "data/box/parent/child.sy": sy("child", "Child", [paragraph([
      text("Body "), image("assets/image.png"), image("../../assets/image.png"),
      { Type: "NodeTextMark", TextMarkType: "tag", TextMarkTextContent: "工作" },
    ])], { tags: "工作, 个人", createdAt: "2025-01-01T18:00:00+08:00", updatedAt: "2025-01-02T10:00:00Z" }),
    "data/assets/image.png": png,
  }, async (input, notes, reads) => {
    assert.equal(isSiyuanMigration(input.files), true);
    await stageSiyuanMigration(input);
    assert.equal(notes.length, 2);
    const child = notes.find((note) => note.source.sourceId === "child")!;
    assert.deepEqual(child.path, ["Knowledge", "Parent"]);
    assert.equal(child.source.platform, "siyuan");
    assert.equal(child.createdAt, "2025-01-01T10:00:00.000Z");
    assert.equal(child.updatedAt, "2025-01-02T10:00:00.000Z");
    assert.deepEqual(new Set(child.tags), new Set(["工作", "个人"]));
    assert.equal(child.attachments.length, 1);
    assert.equal(child.attachments[0].path, "data/assets/image.png");
    assert.equal(child.attachments[0].mimeType, "image/png");
    assert.equal(child.content.split(child.attachments[0].originalPath!).length - 1, 2);
    assert.equal(reads.filter((name) => name.endsWith("child.sy")).length, 2);
    assert.equal(reads.filter((name) => name.endsWith("parent.sy")).length, 2);
  });
});

test("document references map to NMF while nested blocks and outside references preserve their original links", async () => {
  await fixture({
    "one.sy": sy("one", "One", [paragraph([
      { Type: "NodeTextMark", TextMarkType: "block-ref", TextMarkBlockRefID: "two", TextMarkTextContent: "Read two" },
      { Type: "NodeBlockRef", Children: [{ Type: "NodeBlockRefID", Data: "block-inside-two" }, { Type: "NodeBlockRefDynamicText", Data: "Nested block" }] },
      { Type: "NodeTextMark", TextMarkType: "a", TextMarkTextContent: "Outside", TextMarkAHref: "siyuan://blocks/not-in-package" },
    ])]),
    "two.sy": sy("two", "Two", [{ ID: "block-inside-two", ...paragraph([text("Target block")]) }]),
  }, async (input, notes) => {
    const result = await stageSiyuanMigration(input);
    const one = notes.find((note) => note.source.sourceId === "one")!;
    assert.deepEqual(one.links, [{ href: "siyuan://blocks/two", targetSourceId: "two" }]);
    assert.match(one.content, /\[Read two\]\(siyuan:\/\/blocks\/two\)/);
    assert.match(one.content, /\[Nested block\]\(siyuan:\/\/blocks\/block-inside-two\)/);
    assert.match(one.content, /siyuan:\/\/blocks\/not-in-package/);
    assert.ok(result.warnings.some((warning) => warning.startsWith("SIYUAN_BLOCK_ANCHOR_PRESERVED")));
  });
});

test("time without a timezone and custom fields are reported without using the server timezone or property values", async () => {
  await fixture({ "doc.sy": sy("doc", "Doc", [paragraph([text("Body")])], { created: "20250101100000", updated: "20250102120000", "custom-credential": "source-private-value" }) }, async (input, notes) => {
    const result = await stageSiyuanMigration(input);
    assert.equal(notes[0].createdAt, undefined); assert.equal(notes[0].updatedAt, undefined);
    assert.equal(notes[0].metadata.siyuanCreatedLocal, "20250101100000");
    assert.equal(notes[0].metadata.siyuanUpdatedLocal, "20250102120000");
    assert.equal(notes[0].metadata.siyuanUnsupportedPropertyNames, "custom-credential");
    assert.ok(result.warnings.some((warning) => warning.startsWith("SIYUAN_LOCAL_TIME_UNVERIFIED")));
    assert.ok(!JSON.stringify(result).includes("source-private-value"));
    assert.ok(!JSON.stringify(notes[0].metadata).includes("source-private-value"));
  });
});

test("Siyuan HTML and embeds cannot execute scripts or fetch remote resources", async () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("network must not be used"); };
  try {
    await fixture({ "doc.sy": sy("doc", "Doc", [
      { Type: "NodeHTMLBlock", Data: '<p>Safe</p><script>credentialSteal()</script><img src="http://169.254.169.254/private" onerror="steal()">' },
      { Type: "NodeIFrame", Data: '<iframe src="https://example.com/embed?secret=fixture-secret"></iframe>' },
      paragraph([{ Type: "NodeTextMark", TextMarkType: "a", TextMarkAHref: "javascript:alert(1)", TextMarkTextContent: "unsafe" }]),
      { Type: "NodeAttributeView" },
    ]) }, async (input, notes) => {
      const result = await stageSiyuanMigration(input);
      assert.equal(requests, 0);
      assert.doesNotMatch(notes[0].content, /<script|<iframe|onerror|javascript:/);
      assert.match(notes[0].content, /思源嵌入内容/);
      assert.ok(result.warnings.some((warning) => warning.startsWith("SIYUAN_COMPONENTS_DOWNGRADED")));
      assert.ok(result.warnings.some((warning) => warning.startsWith("SIYUAN_EXTERNAL_RESOURCES_PRESERVED")));
      assert.ok(!JSON.stringify(result).includes("fixture-secret"));
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("stable folder normalization distinguishes same-title parents and root notebook metadata", async () => {
  await fixture({
    ".siyuan/conf.json": JSON.stringify({ name: "Notebook" }),
    "parent-a.sy": sy("a", "Same parent"), "parent-a/one.sy": sy("one", "One"),
    "parent-b.sy": sy("b", "Same parent"), "parent-b/two.sy": sy("two", "Two"),
    "history/old.sy": sy("old", "Old"),
  }, async (input, notes) => {
    const result = await stageSiyuanMigration(input);
    const one = notes.find((note) => note.source.sourceId === "one")!, two = notes.find((note) => note.source.sourceId === "two")!;
    assert.equal(notes.length, 4); assert.equal(one.path[0], "Notebook");
    assert.notEqual(one.path[1], two.path[1]); assert.match(one.path[1], /^Same parent \[/);
    assert.ok(result.warnings.some((warning) => warning.startsWith("SIYUAN_NONCURRENT_DOCUMENTS_SKIPPED")));
    const first = JSON.stringify(notes); notes.length = 0; await stageSiyuanMigration(input); assert.equal(JSON.stringify(notes), first);
  });
});

test("duplicate IDs, invalid documents and excessive AST depth fail before emitting any note", async () => {
  await fixture({ "a.sy": sy("duplicate", "A"), "b.sy": sy("duplicate", "B") }, async (input, notes) => {
    await assert.rejects(stageSiyuanMigration(input), /MIGRATION_SIYUAN_DUPLICATE_ID/); assert.equal(notes.length, 0);
  });
  await fixture({ "a.sy": sy("a", "A"), "z.sy": "not JSON" }, async (input, notes) => {
    await assert.rejects(stageSiyuanMigration(input), /MIGRATION_SIYUAN_INVALID_DOCUMENT/); assert.equal(notes.length, 0);
  });
  let nested: unknown = text("deep"); for (let depth = 0; depth < 66; depth++) nested = paragraph([nested]);
  await fixture({ "deep.sy": sy("deep", "Deep", [nested]) }, async (input) => {
    await assert.rejects(stageSiyuanMigration(input), /MIGRATION_SIYUAN_AST_LIMIT/);
  });
  await fixture({ "bad.sy": JSON.stringify({ Type: "NodeDocument", Properties: "not an object" }) }, async (input) => {
    await assert.rejects(stageSiyuanMigration(input), /MIGRATION_SIYUAN_INVALID_DOCUMENT/);
  });
});

test("Siyuan cancellation is checked during indexing and invalid asset bytes are rejected", async () => {
  await fixture({ "doc.sy": sy("doc", "Doc") }, async (input, notes) => {
    input.assertActive = () => { throw new Error("cancelled"); };
    await assert.rejects(stageSiyuanMigration(input), /cancelled/); assert.equal(notes.length, 0);
  });
  await fixture({ "doc.sy": sy("doc", "Doc", [paragraph([image("assets/spoof.png")])]), "assets/spoof.png": "<script>not PNG</script>" }, async (input) => {
    await assert.rejects(stageSiyuanMigration(input), /MIGRATION_ASSET_TYPE_MISMATCH/);
  });
});

test("the existing issue 284 SiYuan fixture retains Callout, table and local audio through the shared converter", async () => {
  const document = fs.readFileSync(path.resolve(__dirname, "fixtures/siyuan/issue-284/20260719010101-demo284.sy"), "utf8");
  await fixture({
    "data/issue284/20260719010101-demo284.sy": document,
    "data/issue284/assets/issue-284-sound.mp3": Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]),
  }, async (input, notes) => {
    const result = await stageSiyuanMigration(input);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].source.sourceId, "20260719010101-demo284");
    assert.match(notes[0].content, /\[!TIP\]- 温馨提示/);
    assert.match(notes[0].content, /\| 项目 \| 状态 \|/);
    assert.equal(notes[0].attachments.length, 1);
    assert.equal(notes[0].attachments[0].mimeType, "audio/mpeg");
    assert.doesNotMatch(notes[0].content, /<iframe|\{:\s*id=/);
    assert.ok(result.warnings.some((warning) => warning.startsWith("SIYUAN_EMBED_DOWNGRADED")));
  });
});
