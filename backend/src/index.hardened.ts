// Install schema/route hardening before the main backend module evaluates.
import "./runtime/task-stats-hardening.js";
// Recover interrupted embedding jobs before the legacy worker starts polling.
import "./runtime/embedding-queue-hardening.js";
// Must load after task-stats-hardening so this wrapper registers selected-section splitting before
// the legacy all-section route when /api/notes is mounted.
import "./runtime/note-split-selection.js";
// Loaded after the Markdown selection wrapper so Tiptap requests are registered first, then
// non-Tiptap requests continue through the existing Markdown and legacy handlers.
import "./runtime/note-split-tiptap.js";
// Wrap /api/blocks/resolve before the standard block router so old noteId + blockId links can follow
// durable note-split records without rewriting the source notes that contain those links.
import "./runtime/block-link-redirect.js";
// Add an atomic Tiptap block patch endpoint while preserving all existing single-block routes.
import "./runtime/block-patch.js";
import "./runtime/auto-full-backup.js";
import "./runtime/notebook-publication.js";
import "./index.js";
