import React, { useMemo } from "react";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import TiptapEditor from "@/components/TiptapEditor";
import { normalizeSheetData, sheetCellKey } from "@/lib/sheetModel";
import { renderSharedMindMapSnapshot } from "@/lib/sharedMindMapSnapshots";
import type { PublicKnowledgeResourceContent } from "@/lib/notebookPublicationApi";
import type { Note } from "@/types";

export default function PublicKnowledgeResourceRenderer({
  resource,
}: {
  resource: PublicKnowledgeResourceContent;
}) {
  const fakeNote = useMemo<Note | null>(() => {
    if (resource.resourceType !== "note") return null;
    return {
      id: resource.resourceId,
      userId: "public",
      notebookId: resource.notebookId || "",
      workspaceId: null,
      title: resource.title || "",
      content: resource.content || "{}",
      contentText: resource.contentText || "",
      isPinned: 0,
      isFavorite: 0,
      isLocked: 1,
      isArchived: 0,
      isTrashed: 0,
      trashedAt: null,
      sortOrder: 0,
      version: resource.version || 0,
      createdAt: resource.updatedAt,
      updatedAt: resource.updatedAt,
      contentFormat: resource.contentFormat || "tiptap-json",
      tags: [],
    } as Note;
  }, [resource]);

  if (resource.resourceType === "note") {
    return resource.contentFormat === "md" ? (
      <MarkdownPreview markdown={resource.content || ""} compact className="p-0" />
    ) : fakeNote ? (
      <TiptapEditor
        note={fakeNote}
        editable={false}
        onUpdate={() => undefined}
        isGuest
        presentationMode
      />
    ) : null;
  }

  if (resource.resourceType === "mindmap") {
    const html = renderSharedMindMapSnapshot({
      id: resource.resourceId,
      title: resource.title,
      data: resource.data || "",
      updatedAt: resource.updatedAt,
    });
    return (
      <div
        className="public-mindmap-resource"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (resource.resourceType === "sheet") {
    const sheet = normalizeSheetData((() => {
      try { return JSON.parse(resource.data || "{}"); } catch { return {}; }
    })());
    const visibleRows = sheet.rows.slice(0, 300);
    const visibleColumns = sheet.columns.slice(0, 80);
    const truncated = visibleRows.length < sheet.rows.length || visibleColumns.length < sheet.columns.length;
    return (
      <div>
        <div className="max-w-full overflow-auto rounded-xl border border-app-border bg-app-surface">
          <table className="min-w-max border-collapse text-xs">
            <thead className="sticky top-0 z-[1] bg-app-sidebar">
              <tr>
                <th className="w-10 border-b border-r border-app-border px-2 py-2 text-center font-medium text-tx-tertiary">#</th>
                {visibleColumns.map((column) => (
                  <th
                    key={column.id}
                    className="border-b border-r border-app-border px-3 py-2 font-semibold text-tx-secondary"
                    style={{ width: column.width, minWidth: column.width, textAlign: column.align }}
                  >
                    {column.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={row.id} style={{ height: row.height }}>
                  <th className="border-b border-r border-app-border bg-app-sidebar px-2 text-center font-normal text-tx-tertiary">{rowIndex + 1}</th>
                  {visibleColumns.map((column) => (
                    <td
                      key={column.id}
                      className="border-b border-r border-app-border px-3 py-2 text-tx-primary"
                      style={{ textAlign: column.align }}
                    >
                      {sheet.cells[sheetCellKey(row.id, column.id)] || ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {truncated && (
          <p className="mt-2 text-xs text-tx-tertiary">
            为保证公开页性能，当前只展示前 300 行 × 80 列；完整数据仍保存在原表格中。
          </p>
        )}
      </div>
    );
  }

  return null;
}
