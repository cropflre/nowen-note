import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NOTE_THEME_ID,
  normalizeNoteThemeId,
} from "../src/runtime/note-appearance";

test("default note theme is stored as inheritance/null metadata", () => {
  assert.equal(normalizeNoteThemeId(DEFAULT_NOTE_THEME_ID), null);
  assert.equal(normalizeNoteThemeId(""), null);
  assert.equal(normalizeNoteThemeId(null), null);
});

test("publisher-style theme ids are normalized without allowing CSS or remote URLs", () => {
  assert.equal(normalizeNoteThemeId(" Publisher.Paper-V2 "), "publisher.paper-v2");
  assert.equal(normalizeNoteThemeId("https://evil.example/theme.css"), null);
  assert.equal(normalizeNoteThemeId("theme id with spaces"), null);
  assert.equal(normalizeNoteThemeId("@import"), null);
  assert.equal(normalizeNoteThemeId("a".repeat(97)), null);
});
