import { v4 as uuid } from "uuid";

import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { buildTiptapBlockIndexPlan } from "../lib/noteBlocksRuntime";
import { extractNoteLinksFromContent } from "../lib/noteLinks";
import { rewriteAutomaticNoteLinkTitles } from "../lib/noteLinkTitles";
import type { NoteLinkEntry } from "../repositories/types";

interface SourceNoteRow {
  id: string;
  userId: string;
  content: string;
  contentFormat: string;
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(dialect?: DatabaseDialect): DatabaseDialect {
  if (dialect) return dialect;
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

async function filterExistingTargets(
  adapter: DatabaseAdapter,
  sourceNoteId: string,
  links: NoteLinkEntry[],
): Promise<NoteLinkEntry[]> {
  const candidates = links.filter(
    (link) => !(link.targetNoteId === sourceNoteId.toLowerCase() && !link.targetBlockId),
  );
  const targetIds = [...new Set(candidates.map((link) => link.targetNoteId))];
  if (targetIds.length === 0) return [];

  const placeholders = targetIds.map(() => "?").join(",");
  const rows = await adapter.queryMany<{ id: string }>(
    `SELECT id FROM notes WHERE id IN (${placeholders})`,
    targetIds,
  );
  const existing = new Set(rows.map((row) => String(row.id).toLowerCase()));
  return candidates.filter((link) => existing.has(link.targetNoteId.toLowerCase()));
}

export function createNoteLinkTitlesRuntime(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const db = resolveAdapter(adapter);
  const dbDialect = resolveDialect(dialect);

  return {
    /**
     * PostgreSQL/SQLite Runtime implementation of automatic note-link title propagation.
     * Each rewritten source note is persisted atomically with its Block index and backlinks.
     */
    async syncAutomaticNoteLinkTitlesAsync(
      targetNoteId: string,
      oldTitle: string,
      newTitle: string,
    ): Promise<string[]> {
      if (!newTitle || oldTitle === newTitle) return [];

      const activePredicate = dbDialect === "postgres"
        ? 'n."isTrashed" = false'
        : 'n."isTrashed" = 0';
      const rows = await db.queryMany<SourceNoteRow>(
        `SELECT DISTINCT n.id,
                n."userId" AS "userId",
                n.content,
                n."contentFormat" AS "contentFormat"
           FROM note_links nl
           JOIN notes n ON n.id = nl."sourceNoteId" AND ${activePredicate}
          WHERE nl."targetNoteId" = ?
            AND n."contentFormat" = 'tiptap-json'`,
        [targetNoteId],
      );

      const updated: string[] = [];
      for (const row of rows) {
        const rewritten = rewriteAutomaticNoteLinkTitles(
          row.content,
          targetNoteId,
          oldTitle,
          newTitle,
        );
        if (!rewritten) continue;

        const blockPlan = buildTiptapBlockIndexPlan(row.id, rewritten);
        if (!blockPlan) continue;
        const links = await filterExistingTargets(
          db,
          row.id,
          extractNoteLinksFromContent(blockPlan.content),
        );

        const statements: Array<{ sql: string; params?: unknown[] }> = [
          {
            sql: `UPDATE notes
                     SET content = ?,
                         "contentText" = ?,
                         version = version + 1,
                         "updatedAt" = CURRENT_TIMESTAMP
                   WHERE id = ?`,
            params: [blockPlan.content, blockPlan.contentText, row.id],
          },
          {
            sql: 'DELETE FROM note_blocks_index WHERE "noteId" = ?',
            params: [row.id],
          },
          ...blockPlan.rows.map((block) => ({
            sql: `INSERT INTO note_blocks_index (
                    "noteId", "blockId", "blockType", "parentBlockId", "blockOrder",
                    "plainText", "contentHash", path, "startOffset", "endOffset",
                    "createdAt", "updatedAt"
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            params: [
              block.noteId,
              block.blockId,
              block.blockType,
              block.parentBlockId,
              block.blockOrder,
              block.plainText,
              block.contentHash,
              block.path,
              block.startOffset,
              block.endOffset,
            ],
          })),
          {
            sql: 'DELETE FROM note_links WHERE "sourceNoteId" = ?',
            params: [row.id],
          },
        ];

        const insertPrefix = dbDialect === "postgres" ? "INSERT INTO" : "INSERT OR IGNORE INTO";
        const conflictSuffix = dbDialect === "postgres" ? " ON CONFLICT DO NOTHING" : "";
        for (const link of links) {
          statements.push({
            sql: `${insertPrefix} note_links (
                    id, "userId", "sourceNoteId", "targetNoteId", "targetBlockId",
                    "sourceBlockId", "linkType", "linkText", excerpt,
                    "createdAt", "updatedAt"
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)${conflictSuffix}`,
            params: [
              uuid(),
              row.userId,
              row.id,
              link.targetNoteId,
              link.targetBlockId,
              link.sourceBlockId,
              link.linkType,
              link.linkText,
              link.excerpt,
            ],
          });
        }

        await db.executeStatements(statements);
        updated.push(row.id);
      }

      return updated;
    },
  };
}

export async function syncAutomaticNoteLinkTitlesAsync(
  targetNoteId: string,
  oldTitle: string,
  newTitle: string,
): Promise<string[]> {
  return createNoteLinkTitlesRuntime().syncAutomaticNoteLinkTitlesAsync(
    targetNoteId,
    oldTitle,
    newTitle,
  );
}
