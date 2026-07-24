from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


backend_path = ROOT / "backend/src/routes/notebooks.ts"
backend = backend_path.read_text(encoding="utf-8-sig")
start_marker = "// User-facing collaboration entry: notebooks shared with the current user."
end_marker = 'app.get("/share/:token"'
start = backend.index(start_marker)
end = backend.index(end_marker, start)

shared_route = '''// User-facing collaboration entry: notebooks shared with the current user.
//
// Return the complete authorized descendant tree for every directly shared root. The query:
// - never walks upward to ancestors or sideways to siblings;
// - filters soft-deleted descendants;
// - de-duplicates overlapping share roots;
// - keeps the source parentId so clients can rebuild the visible tree;
// - reports recursive note counts for every visible node.
app.get("/shared-with-me", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const rows = db
    .prepare(
      `
      WITH RECURSIVE
      direct_shared(sharedRootId, inheritedRole) AS (
        SELECT nb.id, nm.role
        FROM notebook_members nm
        JOIN notebooks nb ON nb.id = nm.notebookId
        WHERE nm.userId = ?
          AND nm.status = 'active'
          AND nb.userId <> ?
          AND nb.isDeleted = 0
      ),
      shared_tree(sharedRootId, descendantId, inheritedRole, depth) AS (
        SELECT sharedRootId, sharedRootId, inheritedRole, 0
        FROM direct_shared
        UNION ALL
        SELECT t.sharedRootId, child.id, t.inheritedRole, t.depth + 1
        FROM shared_tree t
        JOIN notebooks child ON child.parentId = t.descendantId
        WHERE child.isDeleted = 0
      ),
      ranked_visible AS (
        SELECT
          sharedRootId,
          descendantId,
          inheritedRole,
          depth,
          ROW_NUMBER() OVER (
            PARTITION BY descendantId
            ORDER BY
              CASE inheritedRole WHEN 'editor' THEN 2 ELSE 1 END DESC,
              depth ASC,
              sharedRootId ASC
          ) AS rankIndex
        FROM shared_tree
      ),
      visible(sharedRootId, descendantId, inheritedRole, depth) AS (
        SELECT sharedRootId, descendantId, inheritedRole, depth
        FROM ranked_visible
        WHERE rankIndex = 1
      ),
      visible_tree(ancestorId, descendantId) AS (
        SELECT descendantId, descendantId
        FROM visible
        UNION ALL
        SELECT tree.ancestorId, child.id
        FROM visible_tree tree
        JOIN notebooks child ON child.parentId = tree.descendantId
        JOIN visible authorized ON authorized.descendantId = child.id
        WHERE child.isDeleted = 0
      ),
      note_counts(notebookId, noteCount) AS (
        SELECT tree.ancestorId, COUNT(notes.id)
        FROM visible_tree tree
        JOIN notes ON notes.notebookId = tree.descendantId
        WHERE notes.isTrashed = 0
        GROUP BY tree.ancestorId
      )
      SELECT
        nb.*,
        visible.sharedRootId,
        visible.inheritedRole,
        visible.depth AS sharedDepth,
        COALESCE(note_counts.noteCount, 0) AS noteCount
      FROM visible
      JOIN notebooks nb ON nb.id = visible.descendantId
      LEFT JOIN note_counts ON note_counts.notebookId = nb.id
      ORDER BY
        visible.sharedRootId ASC,
        visible.depth ASC,
        nb.sortOrder ASC,
        nb.createdAt ASC,
        nb.id ASC
    `,
    )
    .all(userId, userId) as any[];

  return c.json(
    rows.map((row) => {
      const { permission } = resolveNotebookPermission(row.id, userId);
      const canWrite = hasPermission(permission, "write");
      return {
        ...row,
        myRole: canWrite ? "editor" : "viewer",
        permission,
      };
    }),
  );
});

'''
backend = backend[:start] + shared_route + backend[end:]
backend_path.write_text(backend, encoding="utf-8")

sidebar_path = ROOT / "frontend/src/components/Sidebar.tsx"
sidebar = sidebar_path.read_text(encoding="utf-8-sig")
sidebar = replace_once(
    sidebar,
    'import NotebookShareDialog from "@/components/NotebookShareDialog";\n',
    'import NotebookShareDialog from "@/components/NotebookShareDialog";\n'
    'import SharedNotebookTree from "@/components/SharedNotebookTree";\n',
    "Sidebar import",
)

render_start_marker = '      {sharedNotebooks.length > 0 && (\n'
render_end_marker = '      <div className="border-t border-app-border shrink-0">\n'
render_start = sidebar.index(render_start_marker)
render_end = sidebar.index(render_end_marker, render_start)
shared_render = '''      {sharedNotebooks.length > 0 && (
        <SharedNotebookTree
          notebooks={sharedNotebooks}
          selectedNotebookId={state.selectedNotebookId}
          activeNoteId={state.activeNote?.id ?? null}
          showNotes={showNotesInNotebookTree}
          notesByNotebookId={notesByNotebookId}
          loadingNotebookIds={loadingNotebookIds}
          refreshToken={state.notesRefreshToken}
          onSelectNotebook={stableNotebookSelect}
          onSelectNote={stableSelectNote}
          onLoadNotes={loadNotesForNotebook}
          onCreateNote={stableCreateNote}
        />
      )}

'''
sidebar = sidebar[:render_start] + shared_render + sidebar[render_end:]
sidebar_path.write_text(sidebar, encoding="utf-8")

print("Applied #365 shared notebook tree patch")
