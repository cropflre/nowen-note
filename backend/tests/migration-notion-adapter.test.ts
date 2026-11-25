import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { nmfNoteSchema, type NmfNote } from "../src/services/migrationFormat";
import { createNotionMigrationContext, notionPageId, notionDisplayName, parseNotionCsv } from "../src/services/migrationNotionAdapter";

const root = path.resolve(__dirname, "fixtures/migration-notion");
const workspace = "Workspace 11111111111111111111111111111111";
const database = `${workspace}/Projects 22222222222222222222222222222222`;
const alpha = `${database}/Alpha 33333333333333333333333333333333.md`;
const beta = `${database}/Beta 44444444444444444444444444444444.md`;
const source = { platform: "files", exportId: "notion-export-test" };
const readText = (name: string, maxBytes: number) => {
  const data = fs.readFileSync(path.join(root, name));
  assert.ok(data.length <= maxBytes);
  return new TextDecoder("utf8", { fatal: true }).decode(data);
};
function note(name: string, extra: Partial<NmfNote> = {}): NmfNote {
  return nmfNoteSchema.parse({ schemaVersion: 1, source: { ...source, sourceId: name },
    title: path.posix.basename(name).replace(/\.[^.]+$/, ""), path: path.posix.dirname(name) === "." ? [] : path.posix.dirname(name).split("/"),
    contentFormat: "markdown", content: "# Content", ...extra });
}

test("Notion UUID extraction handles file names, encoded paths and hosted URLs without accepting lookalike hosts", () => {
  for (const value of [
    alpha, "Alpha%2033333333333333333333333333333333.md", "https://www.notion.so/team/Alpha-33333333-3333-3333-3333-333333333333?pvs=4#anchor",
    "https://workspace.notion.site/Alpha-33333333333333333333333333333333", "33333333333333333333333333333333",
  ]) assert.equal(notionPageId(value), "33333333333333333333333333333333");
  for (const value of ["https://notion.so.evil.example/33333333333333333333333333333333", "https://notion.so@evil.example/33333333333333333333333333333333", "https://example.com/33333333333333333333333333333333", "file:///33333333333333333333333333333333", "Alpha%ZZ33333333333333333333333333333333.md"]) {
    assert.equal(notionPageId(value), null);
  }
  assert.equal(notionDisplayName("Projects 22222222222222222222222222222222"), "Projects");
  assert.equal(notionDisplayName("Plan 2026"), "Plan 2026");
});

test("Notion Markdown + CSV decoration keeps stable identity, human paths, internal links and scalar source metadata", () => {
  const context = createNotionMigrationContext({ notePaths: [alpha, beta], csvPaths: [`${database}.csv`], source, readText })!;
  assert.ok(context);
  const raw = note(alpha, { title: "Alpha", content: readText(alpha, 2 * 1024 * 1024),
    links: [{ href: "Beta%2044444444444444444444444444444444.md", targetSourceId: beta }] });
  const decorated = nmfNoteSchema.parse(context.decorate(alpha, raw));
  assert.deepEqual(decorated.source, { platform: "notion", exportId: source.exportId, sourceId: "33333333333333333333333333333333" });
  assert.deepEqual(decorated.path, ["Workspace", "Projects"]);
  assert.equal(decorated.links[0].targetSourceId, "44444444444444444444444444444444");
  assert.ok(decorated.links.some((link) => link.href.includes("?pvs=4") && link.targetSourceId === "44444444444444444444444444444444"));
  assert.ok(!decorated.links.some((link) => link.href.startsWith("https://example.com/")));
  assert.ok(!decorated.links.some((link) => link.href.endsWith("/55555555555555555555555555555555")));
  assert.ok(!decorated.links.some((link) => link.href === "https://www.notion.so/44444444444444444444444444444444"), "code examples must not become links");
  assert.equal(decorated.metadata["notion.csv.Summary"], 'Line one,\nLine "two"');
  assert.equal(decorated.metadata["notion.csv.Formula"], "=SUM(1,2)");
  assert.deepEqual(decorated.tags, [], "CSV strings are never guessed to be tags/dates/formulas");
  assert.equal(decorated.content, raw.content);
  assert.ok(context.warnings.some((warning) => warning.startsWith("NOTION_UNEXPORTED_LINKS")));
  assert.ok(context.warnings.some((warning) => warning.startsWith("NOTION_CSV_PROPERTIES_STAGED_ONLY")));
  assert.equal(context.decorate(beta, note(beta)).title, "Beta");
});

test("Notion detection is explicit or heuristic with a warning and leaves unrelated formats alone", () => {
  assert.equal(createNotionMigrationContext({ notePaths: ["plain.md"], csvPaths: [], source, readText }), null);
  assert.equal(createNotionMigrationContext({ notePaths: ["33333333333333333333333333333333.md"], csvPaths: [], source, readText }), null);
  assert.equal(createNotionMigrationContext({ notePaths: [alpha], csvPaths: [], source: { ...source, platform: "markdown" }, readText }), null);
  assert.ok(createNotionMigrationContext({ notePaths: [alpha], csvPaths: [], source, readText })?.warnings.some((warning) => warning.startsWith("NOTION_FORMAT_INFERRED")));
  const explicit = createNotionMigrationContext({ notePaths: ["plain.md"], csvPaths: [], source: { ...source, platform: "notion" }, readText });
  assert.equal(explicit?.decorate("plain.md", note("plain.md")).source.sourceId, "plain.md");
  assert.equal(createNotionMigrationContext({ notePaths: ["index.html"], csvPaths: [], source, readText: () => '<article class="page">ordinary page</article>' }), null);
  assert.ok(createNotionMigrationContext({ notePaths: ["index.html"], csvPaths: [], source,
    readText: () => '<article class="page sans" id="33333333-3333-3333-3333-333333333333">Notion export</article>' }));
});

test("duplicate exported page UUIDs are rejected before choosing any conflicting page", () => {
  assert.throws(() => createNotionMigrationContext({ notePaths: [alpha, `${database}/Other 33333333333333333333333333333333.md`], csvPaths: [], source, readText }), { code: "NOTION_DUPLICATE_PAGE_ID" });
});

test("CSV quoting preserves commas, CRLF and escaped quotes while malformed or unbounded records are rejected", () => {
  assert.deepEqual(parseNotionCsv('\uFEFFName,Value\r\nAlpha,"a,b\r\n""quoted"""\r\n'), [["Name", "Value"], ["Alpha", 'a,b\r\n"quoted"']]);
  for (const value of ['Name,Value\nAlpha,"unterminated', 'Name,Value\nAlpha,un"quoted', 'Name,Value\nAlpha,"quoted"tail', "Name,Value\nAlpha", "Name,Value\nAlpha,\0bad"]) assert.throws(() => parseNotionCsv(value));
  assert.throws(() => parseNotionCsv("x".repeat(2 * 1024 * 1024 + 1)), { code: "NOTION_CSV_LIMIT" });
  assert.throws(() => parseNotionCsv(Array.from({ length: 257 }, () => "column").join(",")), { code: "NOTION_CSV_LIMIT" });
});

test("ambiguous CSV rows, invalid headers, conflicting values and unsupported fields are reported without guessing", () => {
  const otherAlpha = `Elsewhere 66666666666666666666666666666666/Alpha 77777777777777777777777777777777.md`;
  const csv = new Map([
    ["unscoped.csv", "Name,Status,Status,Empty\nAlpha,one,two,value"],
    [`${database}.csv`, "Name,Status,Status,Long\nAlpha,one,two," + "x".repeat(2049)],
    ["conflict.csv", "Name,State\nBeta,one\nBeta,two"],
    ["invalid.csv", 'Name,State\nBeta,"not closed'],
  ]);
  const context = createNotionMigrationContext({ notePaths: [alpha, beta, otherAlpha], csvPaths: [...csv.keys()], source,
    readText: (name) => csv.get(name)! })!;
  const a = context.decorate(alpha, note(alpha)); const b = context.decorate(beta, note(beta));
  assert.ok(!("notion.csv.Status" in a.metadata), "duplicate column names must not choose the first value");
  assert.ok(!("notion.csv.Long" in a.metadata));
  assert.ok(!("notion.csv.State" in b.metadata), "conflicting rows must not choose a value");
  for (const code of ["NOTION_CSV_UNMAPPED_ROWS", "NOTION_CSV_INVALID_HEADERS", "NOTION_CSV_PROPERTY_LIMIT", "NOTION_CSV_AMBIGUOUS_PROPERTY", "NOTION_CSV_UNREADABLE"]) assert.ok(context.warnings.some((warning) => warning.startsWith(code)), code);
  assert.ok(!JSON.stringify(context.warnings).includes("not closed"));
});

test("Notion HTML links map only exported page IDs and do not execute source instructions", () => {
  const context = createNotionMigrationContext({ notePaths: [alpha, beta], csvPaths: [], source, readText })!;
  const content = '<h1>Instruction data</h1><a href="https://workspace.notion.site/Beta-44444444444444444444444444444444#anchor">Beta</a><a href="https://notion.site.evil.example/44444444444444444444444444444444">External</a>';
  const decorated = context.decorate(alpha, note(alpha, { contentFormat: "html", content }));
  assert.deepEqual(decorated.links, [{ href: "https://workspace.notion.site/Beta-44444444444444444444444444444444#anchor", targetSourceId: "44444444444444444444444444444444" }]);
  assert.equal(decorated.content, content);
});
