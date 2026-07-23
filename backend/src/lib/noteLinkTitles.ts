import type Database from "better-sqlite3";
import { plainTextFromNoteContent, syncNoteBlocks } from "./noteBlocks";
import { syncNoteLinks } from "./noteLinks";

interface SourceNoteRow {
  id: string;
  userId: string;
  content: string;
  contentFormat: string;
}

function normalizeRel(value: unknown, mode: "auto" | "alias"): string {
  const tokens = new Set(String(value || "").split(/\s+/).filter(Boolean));
  tokens.add("noopener");
  tokens.add("noreferrer");
  tokens.add("nofollow");
  tokens.delete(mode === "auto" ? "nowen-title-alias" : "nowen-title-auto");
  tokens.add(mode === "auto" ? "nowen-title-auto" : "nowen-title-alias");
  return Array.from(tokens).join(" ");
}

function targetIdFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const match = href.match(/^note:([0-9a-f-]{36})(?:#blk:[A-Za-z0-9_-]+)?$/i);
  return match?.[1]?.toLowerCase() || null;
}

/**
 * Rewrite automatic-title Tiptap links in one source note.
 *
 * Returns null when the content is invalid, unchanged, or contains only fixed
 * aliases. Keeping this transformation pure lets SQLite and PostgreSQL share
 * the exact same title inference rules.
 */
export function rewriteAutomaticNoteLinkTitles(
  content: string,
  targetNoteId: string,
  oldTitle: string,
  newTitle: string,
): string | null {
  if (!newTitle || oldTitle === newTitle) return null;

  let doc: any;
  try {
    doc = JSON.parse(content || "{}");
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) return null;

  let changed = false;
  const normalizedTargetId = targetNoteId.toLowerCase();
  const visit = (nodes: any[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "text" && Array.isArray(node.marks)) {
        for (const mark of node.marks) {
          if (mark?.type !== "link") continue;
          if (targetIdFromHref(mark?.attrs?.href) !== normalizedTargetId) continue;
          const rel = String(mark?.attrs?.rel || "");
          if (/\bnowen-title-alias\b/.test(rel)) continue;
          const text = String(node.text || "");
          const inferredAuto =
            /\bnowen-title-auto\b/.test(rel) ||
            text === oldTitle ||
            text.startsWith(`${oldTitle} > `) ||
            text === "关联笔记";
          if (!inferredAuto) continue;

          const suffix = text.startsWith(`${oldTitle} > `)
            ? text.slice(oldTitle.length)
            : "";
          node.text = `${newTitle}${suffix}`;
          mark.attrs = { ...(mark.attrs || {}), rel: normalizeRel(rel, "auto") };
          changed = true;
        }
      }
      if (Array.isArray(node.content)) visit(node.content);
    }
  };
  visit(doc.content);
  return changed ? JSON.stringify(doc) : null;
}

/**
 * Keep automatic-title Tiptap links synchronized when a target note is renamed.
 *
 * Markdown auto links store only the stable note ID and resolve the title at render
 * time, so no source rewrite is needed. Fixed aliases are marked through the
 * standard Link `rel` attribute and are intentionally never modified.
 */
export function syncAutomaticNoteLinkTitles(
  db: Database.Database,
  targetNoteId: string,
  oldTitle: string,
  newTitle: string,
): string[] {
  if (!newTitle || oldTitle === newTitle) return [];

  const rows = db.prepare(`
    SELECT DISTINCT n.id, n.userId, n.content, n.contentFormat
    FROM note_links nl
    JOIN notes n ON n.id = nl.sourceNoteId AND n.isTrashed = 0
    WHERE nl.targetNoteId = ? AND n.contentFormat = 'tiptap-json'
  `).all(targetNoteId) as SourceNoteRow[];

  const updated: string[] = [];
  for (const row of rows) {
    const rewritten = rewriteAutomaticNoteLinkTitles(
      row.content,
      targetNoteId,
      oldTitle,
      newTitle,
    );
    if (!rewritten) continue;

    const contentText = plainTextFromNoteContent(rewritten, "tiptap-json");
    db.prepare(`
      UPDATE notes
      SET content = ?, contentText = ?, version = version + 1, updatedAt = datetime('now')
      WHERE id = ?
    `).run(rewritten, contentText, row.id);
    const synced = syncNoteBlocks(db, row.id, rewritten, "tiptap-json");
    syncNoteLinks(db, row.userId, row.id, synced.content);
    updated.push(row.id);
  }
  return updated;
}
