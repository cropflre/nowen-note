from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))


INTERNAL_MEDIA_TYPE = "application/vnd.nowen.internal-note+json"

replace_once(
    "frontend/src/lib/api.impl.ts",
    '      "X-Nowen-Content-View": "internal",',
    f'      "Accept": "{INTERNAL_MEDIA_TYPE}",',
)
replace_once(
    "frontend/src/lib/api.ts",
    '      "X-Nowen-Content-View": "internal",',
    f'      "Accept": "{INTERNAL_MEDIA_TYPE}",',
)
replace_once(
    "backend/src/routes/notes.ts",
    '''function wantsInternalNoteContent(c: any): boolean {
  return c.req.header("X-Nowen-Content-View") === "internal";
}''',
    f'''function wantsInternalNoteContent(c: any): boolean {{
  return (c.req.header("Accept") || "")
    .toLowerCase()
    .includes("{INTERNAL_MEDIA_TYPE}");
}}''',
)

replace_once(
    "backend/src/routes/export.ts",
    'import { projectMarkdownForUser } from "../lib/markdownUserContent";',
    'import { projectMarkdownNoteForUser } from "../lib/markdownUserContent";',
)
replace_once(
    "backend/src/routes/export.ts",
    '''  const visibleNotes = notes.map((note) => note.contentFormat === "markdown"
    ? { ...note, content: projectMarkdownForUser(note.content || "") }
    : note);''',
    '''  const visibleNotes = notes.map((note) =>
    projectMarkdownNoteForUser(db, note),
  );''',
)

# Frontend does not receive the block index. Hide only UUID-shaped IDs that Nowen itself generates;
# user-authored plain text such as ^blk_example remains visible. Backend/API projection additionally
# verifies IDs against note_blocks_index.
replace_once(
    "frontend/src/lib/markdownUserContent.ts",
    'const INLINE_MARKER_RE = /[ \\t]+\\^(blk_[A-Za-z0-9_-]{6,})[ \\t]*$/;\nconst LINE_MARKER_RE = /^[ \\t]*\\^(blk_[A-Za-z0-9_-]{6,})[ \\t]*$/;',
    'const GENERATED_BLOCK_ID = String.raw`blk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;\nconst INLINE_MARKER_RE = new RegExp(String.raw`[ \\t]+\\^(${GENERATED_BLOCK_ID})[ \\t]*$`, "i");\nconst LINE_MARKER_RE = new RegExp(String.raw`^[ \\t]*\\^(${GENERATED_BLOCK_ID})[ \\t]*$`, "i");',
)

frontend_test = r'''import { describe, expect, it } from "vitest";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
} from "../markdownUserContent";

const HEADING_ID = "blk_11111111-1111-4111-8111-111111111111";
const PARAGRAPH_ID = "blk_22222222-2222-4222-8222-222222222222";
const CODE_ID = "blk_33333333-3333-4333-8333-333333333333";

describe("projectMarkdownForUser", () => {
  it("removes generated inline and post-fence markers while preserving code contents", () => {
    const source = [
      `# 标题 ^${HEADING_ID}`,
      "",
      `正文 ^${PARAGRAPH_ID}`,
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      `^${CODE_ID}`,
      "",
      "尾声",
    ].join("\n");

    expect(projectMarkdownForUser(source)).toBe([
      "# 标题",
      "",
      "正文",
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      "",
      "尾声",
    ].join("\n"));
  });

  it("keeps ordinary user-authored ^blk_ text visible", () => {
    const source = "文档中的普通示例 ^blk_example_text";
    expect(projectMarkdownForUser(source)).toBe(source);
  });

  it("returns source offsets for editor decorations", () => {
    const source = `a ^${HEADING_ID}\n^${CODE_ID}\n`;
    expect(findInternalMarkdownMarkerRanges(source).map(({ kind, blockId }) => ({ kind, blockId }))).toEqual([
      { kind: "inline", blockId: HEADING_ID },
      { kind: "line", blockId: CODE_ID },
    ]);
  });
});
'''
write("frontend/src/lib/__tests__/markdownUserContent.test.ts", frontend_test)

route_test = rf'''import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {{ Hono }} from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-content-view-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "content-view-owner";
const notebookId = "content-view-notebook";
const generatedMarker = /\^blk_[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}/i;
let db: Database.Database;
let closeDb: () => void;
let app: Hono;


test.before(async () => {{
  const schema = await import("../src/db/schema");
  const notesRoute = await import("../src/routes/notes");
  db = schema.getDb();
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/api/notes", notesRoute.default);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, owner, "Content View");
}});


test.after(() => {{
  closeDb?.();
  fs.rmSync(tmpDir, {{ recursive: true, force: true }});
}});


test("ordinary Note REST responses are clean while the trusted media type retains internal IDs", async () => {{
  const source = [
    "# API 标题",
    "",
    "```text",
    "^blk_user_example",
    "```",
  ].join("\n");
  const create = await app.request("/api/notes", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json", "X-User-Id": owner }},
    body: JSON.stringify({{ notebookId, title: "Content View", content: source, contentFormat: "markdown" }}),
  }});
  assert.equal(create.status, 201);
  const publicCreated = await create.json() as any;
  assert.doesNotMatch(publicCreated.content, generatedMarker);
  assert.match(publicCreated.content, /\^blk_user_example/);

  const stored = db.prepare("SELECT content FROM notes WHERE id = ?").get(publicCreated.id) as {{ content: string }};
  assert.match(stored.content, generatedMarker);

  const publicGet = await app.request(`/api/notes/${{publicCreated.id}}`, {{
    headers: {{ "X-User-Id": owner }},
  }});
  assert.equal(publicGet.status, 200);
  const publicPayload = await publicGet.json() as any;
  assert.doesNotMatch(publicPayload.content, generatedMarker);
  assert.match(publicPayload.content, /\^blk_user_example/);

  const internalGet = await app.request(`/api/notes/${{publicCreated.id}}`, {{
    headers: {{
      "X-User-Id": owner,
      "Accept": "{INTERNAL_MEDIA_TYPE}",
    }},
  }});
  assert.equal(internalGet.status, 200);
  const internalPayload = await internalGet.json() as any;
  assert.match(internalPayload.content, generatedMarker);
  assert.match(internalPayload.content, /\^blk_user_example/);
}});
'''
write("backend/tests/notes-content-view.test.ts", route_test)

print("Issue #355 boundary fixes applied")
