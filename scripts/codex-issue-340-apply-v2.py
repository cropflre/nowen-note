from pathlib import Path

root = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"missing {label} in {path}")
    path.write_text(text.replace(old, new, 1))


search_route = root / "backend/src/routes/search.ts"
replace_once(search_route, 'import { Hono } from "hono";', 'import { Hono, type Context } from "hono";', "Hono Context import")
replace_once(search_route, '  c: Parameters<Parameters<typeof app.get>[1]>[0],', '  c: Context,', "search timing Context type")

notes = root / "backend/src/routes/notes.ts"
replace_once(
    notes,
    'import { syncNoteBlocks } from "../lib/noteBlocks";',
    'import { syncNoteBlocks } from "../lib/noteBlocks";\nimport { extractSearchableText } from "../lib/searchIndex";',
    "notes search index import",
)
replace_once(
    notes,
    '''  try {
    // contentFormat: 区分原生 Markdown 笔记与富文本笔记
    const contentFormat = body.contentFormat === "markdown" ? "markdown"
      : body.contentFormat === "html" ? "html"
      : "tiptap-json";
    // Markdown 笔记默认 content 为空 Markdown；富文本默认为空 Tiptap JSON
    const defaultContent = contentFormat === "markdown" ? "# 无标题 Markdown\\n\\n" : "{}";

    db.prepare(`''',
    '''  // contentText 由服务端从正文派生，客户端提交值不再作为索引真源。
  const contentFormat = body.contentFormat === "markdown" ? "markdown"
    : body.contentFormat === "html" ? "html"
    : "tiptap-json";
  const defaultContent = contentFormat === "markdown" ? "# 无标题 Markdown\\n\\n" : "{}";
  const initialContent = typeof body.content === "string" ? body.content : defaultContent;

  try {
    db.prepare(`''',
    "server-derived create content",
)
replace_once(
    notes,
    '''      id, userId, inheritedWorkspaceId, body.notebookId,
      body.title || "无标题笔记", body.content || defaultContent, body.contentText || "",
      contentFormat,''',
    '''      id, userId, inheritedWorkspaceId, body.notebookId,
      body.title || "无标题笔记", initialContent,
      extractSearchableText(initialContent, contentFormat), contentFormat,''',
    "create contentText values",
)
replace_once(
    notes,
    '  let finalContent: string | undefined = typeof body.content === "string" ? body.content : undefined;',
    '  let finalContent = initialContent;',
    "create finalContent source",
)
replace_once(
    notes,
    '''        normalizedLinkContent = synced.content;
        finalContent = synced.content;''',
    '''        db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
          .run(synced.content, synced.contentText, id);
        normalizedLinkContent = synced.content;
        finalContent = synced.content;''',
    "persist created searchable text",
)
replace_once(
    notes,
    '  if (body.title !== undefined) { fields.push("title = ?"); params.push(body.title); }',
    '''  // Ignore untrusted client contentText and derive the searchable text after any
  // inline-image rewrite, using the effective stored content and format.
  if (body.content !== undefined || body.contentFormat !== undefined) {
    const currentSearchSource = db.prepare(
      "SELECT content, contentFormat FROM notes WHERE id = ?",
    ).get(id) as { content: string; contentFormat: string } | undefined;
    const effectiveContent = typeof body.content === "string"
      ? body.content
      : currentSearchSource?.content || "";
    const effectiveFormat = typeof body.contentFormat === "string"
      ? body.contentFormat
      : currentSearchSource?.contentFormat || "tiptap-json";
    body.contentText = extractSearchableText(effectiveContent, effectiveFormat);
  } else if (body.contentText !== undefined) {
    delete body.contentText;
  }

  if (body.title !== undefined) { fields.push("title = ?"); params.push(body.title); }''',
    "derive update contentText",
)
replace_once(
    notes,
    '''        normalizedLinkContent = synced.content;
        body.content = synced.content;
        body.contentText = synced.contentText;''',
    '''        db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
          .run(synced.content, synced.contentText, id);
        normalizedLinkContent = synced.content;
        body.content = synced.content;
        body.contentText = synced.contentText;''',
    "persist updated searchable text",
)

migrations = root / "backend/src/db/migrations.ts"
replace_once(
    migrations,
    'import type Database from "better-sqlite3";\n',
    'import type Database from "better-sqlite3";\nimport { markSearchIndexRebuilt, repairSearchContentText } from "../lib/searchIndex.js";\n',
    "migration search repair import",
)
replace_once(
    migrations,
    'export const MIGRATIONS: Migration[] = [',
    '''const repairSearchContentTextMigration: Migration = {
  version: 52,
  name: "repair-search-content-text",
  up: (db) => {
    repairSearchContentText(db);
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    markSearchIndexRebuilt(db);
  },
};

export const MIGRATIONS: Migration[] = [''',
    "v52 search repair migration",
)
replace_once(
    migrations,
    '''  noteImportOriginsMigration,
].sort((a, b) => a.version - b.version);''',
    '''  noteImportOriginsMigration,
  repairSearchContentTextMigration,
].sort((a, b) => a.version - b.version);''',
    "register v52 migration",
)

experience = root / "backend/tests/search-experience.test.ts"
replace_once(experience, 'const MUTABLE_NOTE_ID = "search-mutable";\n', 'const MUTABLE_NOTE_ID = "search-mutable";\nconst STALE_NOTE_ID = "search-stale-content";\n', "stale note constant")
replace_once(
    experience,
    '''function insertNote(id: string, title: string, contentText: string, contentFormat = "markdown") {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, OWNER_ID, NOTEBOOK_ID, title, contentText, contentFormat);
}''',
    '''function insertNote(
  id: string,
  title: string,
  contentText: string,
  contentFormat = "markdown",
  content = contentText,
) {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, OWNER_ID, NOTEBOOK_ID, title, content, contentText, contentFormat);
}''',
    "search test note helper",
)
replace_once(
    experience,
    '  insertNote(MUTABLE_NOTE_ID, "Mutable note", "before unique-old-keyword");\n',
    '''  insertNote(MUTABLE_NOTE_ID, "Mutable note", "before unique-old-keyword");
  insertNote(
    STALE_NOTE_ID,
    "Historical stale note",
    "",
    "markdown",
    "# Historical note\\n\\nhistoricalrepairkeyword",
  );
''',
    "historical stale fixture",
)
replace_once(
    experience,
    '''  assert.equal(response.status, 200);
  assert.equal(response.json.length, 1);''',
    '''  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-search-literal-fallback"), "0");
  assert.equal(response.json.length, 1);''',
    "indexed English header assertion",
)
replace_once(
    experience,
    '''  assert.equal(response.status, 200);
  const result = response.json.find((item) => item.id === CHINESE_NOTE_ID);''',
    '''  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-search-literal-fallback"), "1");
  const result = response.json.find((item) => item.id === CHINESE_NOTE_ID);''',
    "Chinese fallback assertion",
)
replace_once(
    experience,
    '''  assert.equal(response.status, 200);
  assert.deepEqual(response.json.map((item) => item.id), [CPP_NOTE_ID]);''',
    '''  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-search-literal-fallback"), "1");
  assert.deepEqual(response.json.map((item) => item.id), [CPP_NOTE_ID]);''',
    "punctuation fallback assertion",
)
replace_once(
    experience,
    '''test("search index health is observable and admins can rebuild it safely", async () => {
  const healthResponse = await app.request("/search/health", {''',
    '''test("search index health is observable and admins can rebuild source text safely", async () => {
  assert.deepEqual((await search(OWNER_ID, "historicalrepairkeyword")).json, []);

  const healthResponse = await app.request("/search/health", {''',
    "rebuild precondition",
)
replace_once(
    experience,
    '''  assert.equal(health.healthy, true);
  assert.equal(health.canRebuild, true);''',
    '''  assert.equal(health.healthy, true);
  assert.equal(health.canRebuild, true);
  assert.equal(health.emptyContentTextCount, 1);
  assert.equal(health.staleContentTextCount, 1);''',
    "health stale diagnostics",
)
replace_once(
    experience,
    '''  assert.equal(rebuilt.success, true);
  assert.equal(rebuilt.healthy, true);
  assert.equal((await search(OWNER_ID, "alpha")).json[0]?.id, ENGLISH_NOTE_ID);''',
    '''  assert.equal(rebuilt.success, true);
  assert.equal(rebuilt.healthy, true);
  assert.equal(rebuilt.repairedCount, 1);
  assert.equal(rebuilt.emptyContentTextCount, 0);
  assert.equal(rebuilt.staleContentTextCount, 0);
  assert.equal((await search(OWNER_ID, "alpha")).json[0]?.id, ENGLISH_NOTE_ID);
  assert.equal((await search(OWNER_ID, "historicalrepairkeyword")).json[0]?.id, STALE_NOTE_ID);''',
    "rebuild repairs source text",
)
replace_once(
    experience,
    'test("personal-space search does not expose another user\'s notes", async () => {',
    '''test("indexed candidate retrieval stays bounded with 160 long notes", async () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(400);
  const insertBulk = db().transaction(() => {
    for (let index = 0; index < 160; index += 1) {
      const token = index === 137 ? "boundedcandidatetoken" : `bulksearchtoken${index}`;
      insertNote(
        `search-bulk-${index}`,
        `Bulk note ${index}`,
        `${filler} ${token}`,
      );
    }
  });
  insertBulk();

  const started = performance.now();
  const response = await search(OWNER_ID, "boundedcandidatetoken");
  const elapsed = performance.now() - started;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-search-literal-fallback"), "0");
  assert.ok(Number(response.headers.get("x-search-candidate-count")) <= 5);
  assert.match(response.headers.get("server-timing") || "", /candidate;dur=/);
  assert.equal(response.json[0]?.id, "search-bulk-137");
  assert.ok(elapsed < 1500, `indexed search took ${elapsed.toFixed(1)}ms`);
});

test("personal-space search does not expose another user's notes", async () => {''',
    "bounded performance regression",
)

for temporary in [
    root / "scripts/codex-issue-340-apply.py",
    Path(__file__),
]:
    if temporary.exists():
        temporary.unlink()

print("Applied Issue #340 search reliability and candidate-index patch")
