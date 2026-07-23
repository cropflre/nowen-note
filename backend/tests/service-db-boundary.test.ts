import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const realtimeSource = read("services/realtime.ts");
const attachmentStorageSource = read("services/attachment-storage.ts");
const attachmentReferenceSource = read("services/attachment-reference.ts");
const noteLinksServiceSource = read("services/note-links.ts");
const realtimeRepositorySource = read("repositories/realtimeAuthRepository.ts");
const attachmentReferencesRepositorySource = read("repositories/attachmentReferencesRepository.ts");
const noteLinksRepositorySource = read("repositories/noteLinksRepository.ts");

for (const [name, source] of [
  ["realtime", realtimeSource],
  ["attachment-storage", attachmentStorageSource],
  ["attachment-reference", attachmentReferenceSource],
  ["note-links", noteLinksServiceSource],
] as const) {
  test(`${name} service keeps database access behind repositories`, () => {
    assert.doesNotMatch(source, /from\s+["']\.\.\/db\/schema["']/);
    assert.doesNotMatch(source, /\bgetDb\s*\(/);
    assert.doesNotMatch(source, /\.prepare\s*\(/);
  });
}

test("attachment storage uses the shared system settings repository", () => {
  assert.match(attachmentStorageSource, /systemSettingsRepository\.get\(SETTING_KEY\)/);
  assert.match(attachmentStorageSource, /systemSettingsRepository\.set\(SETTING_KEY/);
  assert.match(attachmentStorageSource, /systemSettingsRepository\.delete\(SETTING_KEY\)/);
});

test("attachment reference service exposes SQLite-compatible and runtime paths", () => {
  assert.match(attachmentReferenceSource, /attachmentReferencesRepository\.getNoteContentText\(noteId\)/);
  assert.match(attachmentReferenceSource, /attachmentReferencesRepository\.getNoteContentTextAsync\(noteId\)/);
  assert.match(attachmentReferenceSource, /syncReferencesAsync\(noteId, normalizedContent\)/);
  assert.match(attachmentReferencesRepositorySource, /getDatabaseAdapter/);
  assert.match(attachmentReferencesRepositorySource, /ON CONFLICT \("attachmentId", "noteId"\) DO NOTHING/);
});

test("realtime authentication delegates user lookup to its repository", () => {
  assert.match(realtimeSource, /realtimeAuthRepository\.findById\(payload\.userId\)/);
  assert.match(realtimeRepositorySource, /SELECT id, username/);
  assert.match(realtimeRepositorySource, /"isDisabled"/);
  assert.match(realtimeRepositorySource, /"tokenVersion"/);
});

test("note links service delegates source owner lookup to its repository", () => {
  assert.match(noteLinksServiceSource, /noteLinksRepository\.getSourceNoteUserId\(noteId\)/);
  assert.match(noteLinksRepositorySource, /SELECT userId FROM notes WHERE id = \?/);
});
