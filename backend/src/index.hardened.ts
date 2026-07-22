// Install schema/route hardening before the main backend module evaluates.
import "./runtime/task-stats-hardening.js";
// Must load after task-stats-hardening so this wrapper registers selected-section splitting before
// the legacy all-section route when /api/notes is mounted.
import "./runtime/note-split-selection.js";
// Loaded after the Markdown selection wrapper so Tiptap requests are registered first, then
// non-Tiptap requests continue through the existing Markdown and legacy handlers.
import "./runtime/note-split-tiptap.js";
import "./runtime/auto-full-backup.js";
import "./runtime/notebook-publication.js";
import "./index.js";
