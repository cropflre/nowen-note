#!/usr/bin/env python3
"""Reconcile known mainline drift after merging main into pg-migration-unified."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def replace_attachment_indexer_import() -> None:
    path = Path("backend/src/services/attachment-indexer.ts")
    source = path.read_text()
    old = 'import { getAttachmentsDir } from "../routes/attachments";'
    new = 'import { getAttachmentsDir } from "./attachment-storage";'
    if old in source:
        source = source.replace(old, new, 1)
    elif new not in source:
        raise SystemExit("attachment-indexer import pattern not found")
    path.write_text(source)


def reconcile_package_import_architecture() -> None:
    path = Path("backend/src/services/nowenPackageImport.ts")
    source = path.read_text()
    old = '''  const notesFolder = zip.folder("notes");
  if (notesFolder) {
    for (const name of Object.keys(notesFolder.files)) {
      if (!name.endsWith("/meta.json")) continue;
'''
    new = r'''  const notesFolder = zip.folder("notes");
  if (notesFolder) {
    for (const name of Object.keys(notesFolder.files)) {
      if (!/^notes\/[^/]+\/meta\.json$/.test(name)) continue;
'''
    if old in source:
        source = source.replace(old, new, 1)
    elif new in source:
        pass
    elif "executeNowenPackageImportWithBatch" in source and "importNowenPackageWithSync" in source:
        pass
    else:
        raise SystemExit("nowenPackageImport architecture not recognized")
    path.write_text(source)


def reconcile_realtime_workspace_recipients() -> None:
    path = Path("backend/src/services/realtime.ts")
    source = path.read_text()
    start_marker = "  const members = getDb().prepare("
    end_marker = "  const userIds = new Set(members.map((member) => member.userId));"
    replacement = '''  const userIds = new Set(
    realtimeAuthRepository.listWorkspaceMemberUserIds(payload.workspaceId),
  );'''
    start = source.find(start_marker)
    end = source.find(end_marker, start)
    if start >= 0 and end >= 0:
        end += len(end_marker)
        source = source[:start] + replacement + source[end:]
    elif replacement not in source:
        raise SystemExit("realtime workspace recipient query markers not found")
    if "getDb().prepare(" in source:
        raise SystemExit("direct realtime database access remains after merge")
    path.write_text(source)


def reconcile_yjs_persistence_semantics() -> None:
    path = Path("backend/src/services/yjs.ts")
    source = path.read_text()

    old_noop = "  if (existing.content === markdown && existing.contentText === contentText) return;"
    new_noop = '''  // The stored Markdown body is authoritative for edit/version identity. A REST or
  // transactional writer may derive contentText with a richer parser than this legacy
  // Yjs fallback. Re-flushing the same Markdown must not overwrite that projection or
  // manufacture a phantom version bump.
  if (existing.content === markdown) return;'''
    if old_noop in source:
        source = source.replace(old_noop, new_noop, 1)
    elif new_noop not in source:
        raise SystemExit("Yjs no-op persistence guard not found")

    persist_timer = "  }, 1500);\n"
    persist_timer_unref = "  }, 1500);\n  room.persistTimer?.unref();\n"
    if persist_timer_unref not in source:
        if source.count(persist_timer) != 1:
            raise SystemExit("Yjs persist timer pattern count changed")
        source = source.replace(persist_timer, persist_timer_unref, 1)

    idle_timer = "    }, ROOM_IDLE_TIMEOUT_MS);\n"
    idle_timer_unref = "    }, ROOM_IDLE_TIMEOUT_MS);\n    room.idleTimer?.unref();\n"
    if idle_timer_unref not in source:
        count = source.count(idle_timer)
        if count != 2:
            raise SystemExit(f"expected two Yjs idle timers, found {count}")
        source = source.replace(idle_timer, idle_timer_unref)

    path.write_text(source)


def reconcile_note_link_contract_tests() -> None:
    path = Path("backend/tests/note-links-repository-async.test.ts")
    source = path.read_text()

    replace_name = 'test("replaceLinksForSourceAsync does not affect other userId"'
    start = source.find(replace_name)
    end = source.find("\n});", start)
    if start < 0 or end < 0:
        raise SystemExit("note links replace contract test not found")
    block = source[start:end]
    block = block.replace(
        "// Other user's link should still exist",
        "// Links are owned by the source note, so replacement removes legacy rows regardless of saver.",
    )
    block = block.replace("assert.equal(otherLinks.length, 1);", "assert.equal(otherLinks.length, 0);")
    source = source[:start] + block + source[end:]

    backlink_name = 'test("getBacklinksAsync does not return links for other userId"'
    start = source.find(backlink_name)
    end = source.find("\n});", start)
    if start < 0 or end < 0:
        raise SystemExit("note links backlink contract test not found")
    block = source[start:end]
    if "assert.equal(backlinks.length, 0);" in block:
        block = block.replace(
            "assert.equal(backlinks.length, 0);",
            "assert.equal(backlinks.length, 1);\n  assert.equal(backlinks[0].sourceNoteId, NOTE_2);",
            1,
        )
    source = source[:start] + block + source[end:]
    path.write_text(source)


def reconcile_rich_text_restore_contract() -> None:
    path = Path("backend/tests/note-version-content-format.test.ts")
    source = path.read_text()

    row_markdown_old = '  assert.equal(row.content, "# Markdown title");'
    row_markdown_new = r'''  assert.equal(
    row.content.replace(/\s+\^blk_[A-Za-z0-9_-]+(?=\n|$)/g, ""),
    "# Markdown title",
  );'''
    if row_markdown_old in source:
        source = source.replace(row_markdown_old, row_markdown_new, 1)
    elif row_markdown_new not in source:
        raise SystemExit("markdown row restore assertion not found")

    rich_old = "  assert.equal(row.content, richTextContent);"
    rich_new = '''  const restoredDoc = JSON.parse(row.content);
  assert.equal(restoredDoc.type, "doc");
  assert.equal(restoredDoc.content?.[0]?.type, "paragraph");
  assert.equal(restoredDoc.content?.[0]?.content?.[0]?.text, "Rich text");
  assert.match(String(restoredDoc.content?.[0]?.attrs?.blockId || ""), /^blk_/);'''
    if rich_old in source:
        source = source.replace(rich_old, rich_new, 1)
    elif rich_new not in source:
        raise SystemExit("rich text restore assertion not found")

    markdown_old = '  assert.equal(restoreB.json.content, "## B\\n\\ncurrent");'
    markdown_new = r'''  assert.equal(
    restoreB.json.content.replace(/\s+\^blk_[A-Za-z0-9_-]+(?=\n|$)/g, ""),
    "## B\n\ncurrent",
  );'''
    if markdown_old in source:
        source = source.replace(markdown_old, markdown_new, 1)
    elif markdown_new not in source:
        raise SystemExit("markdown restore assertion not found")

    text_old = '  assert.equal(restoreB.json.contentText, "B current");'
    text_new = r'''  assert.equal(
    restoreB.json.contentText.replace(/\s+/g, " ").trim(),
    "B current",
  );'''
    if text_old in source:
        source = source.replace(text_old, text_new, 1)
    elif text_new not in source:
        raise SystemExit("markdown restore contentText assertion not found")

    path.write_text(source)


def reconcile_notebook_transfer_tag_scope_contract() -> None:
    path = Path("backend/tests/notebook-transfer-copy.test.ts")
    source = path.read_text()
    source = source.replace(
        'test("tags are mapped with existing global tag uniqueness", () => {',
        'test("tags are copied into the target workspace scope", () => {',
        1,
    )
    old = '''  const result = copy();
  assert.equal(result.tagCount, 0);
  assert.deepEqual(result.warnings, ["tag_reused_due_unique_constraint:Important"]);
  const tag = getDb().prepare("SELECT * FROM tags WHERE workspaceId IS NULL AND name = ?").get("Important") as any;
  assert.ok(tag);'''
    new = '''  const result = copy();
  assert.equal(result.tagCount, 1);
  assert.deepEqual(result.warnings, []);
  const tag = getDb().prepare("SELECT * FROM tags WHERE workspaceId = ? AND name = ?").get(WS, "Important") as any;
  assert.ok(tag);
  assert.equal(tag.workspaceId, WS);'''
    if old in source:
        source = source.replace(old, new, 1)
    elif new not in source:
        raise SystemExit("notebook transfer tag scope assertions not found")
    path.write_text(source)


def reconcile_tag_route_idempotency_contract() -> None:
    path = Path("backend/tests/tags-route-async.test.ts")
    source = path.read_text()
    old = "  assert.equal(duplicate.status, 409);"
    new = '''  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.id, tagId);'''
    if old in source:
        source = source.replace(old, new, 1)
    elif new not in source:
        raise SystemExit("tag route idempotency assertion not found")
    path.write_text(source)


def remove_pre_sync_type_ignores() -> None:
    path = Path("backend/src/index.hardened.ts")
    source = path.read_text()
    source = source.replace(
        "  // @ts-ignore -- this module is introduced by the main synchronization merge below.\n",
        "",
    )
    path.write_text(source)


def register_direct_db_exceptions() -> None:
    path = Path("backend/scripts/direct-db-access-deferred-exceptions.json")
    payload = json.loads(path.read_text())
    files = payload.setdefault("files", {})

    additions = {
        "lib/markdownUserContent.ts": {
            "owner": "#249",
            "reason": "Main introduced Markdown user-content extraction with a synchronous SQLite lookup. PostgreSQL note runtime uses format-specific pure parsers; the legacy helper migrates with the remaining note route boundary.",
            "counts": {"better-sqlite3": 1, "prepare-call": 1},
        },
        "routes/knowledge-tree.ts": {
            "owner": "#249",
            "reason": "Main introduced the unified knowledge-tree route on the default SQLite runtime. Its capability and structural transactions require a dedicated cross-driver Repository batch before PostgreSQL business routing is enabled.",
            "counts": {"getDb-call": 1, "prepare-call": 6, "transaction-call": 1},
        },
        "services/knowledgeCapabilitiesCore.ts": {
            "owner": "#249",
            "reason": "Knowledge capability evaluation arrived on main as a synchronous SQLite service. It remains default-runtime-only until the notebook/note capability Repository is migrated atomically.",
            "counts": {"better-sqlite3": 1, "getDb-call": 7, "prepare-call": 12, "transaction-call": 2},
        },
        "services/knowledgeCapabilitiesResolver.ts": {
            "owner": "#249",
            "reason": "Main added synchronous knowledge capability resolution over SQLite membership and ACL tables. It is owned by the #249 permission Repository batch.",
            "counts": {"better-sqlite3": 1, "getDb-call": 2, "prepare-call": 6},
        },
        "services/knowledgeTreeCore.ts": {
            "owner": "#249",
            "reason": "The new knowledge-tree mutation core spans notebook, note and hierarchy tables in SQLite transactions. It must move as one cross-driver transaction unit under #249.",
            "counts": {"better-sqlite3": 1, "getDb-call": 7, "prepare-call": 33, "transaction-call": 5},
        },
        "services/knowledgeTreeListing.ts": {
            "owner": "#249",
            "reason": "Knowledge-tree listing was introduced on main with a synchronous SQLite query and will migrate with the unified tree Repository boundary.",
            "counts": {"better-sqlite3": 1, "getDb-call": 1, "prepare-call": 1},
        },
        "services/knowledgeTreeRestore.ts": {
            "owner": "#253",
            "reason": "Knowledge-tree restore performs destructive hierarchy recovery in SQLite. Cross-driver backup and restore safety is explicitly owned by #253.",
            "counts": {"better-sqlite3": 1, "getDb-call": 1, "prepare-call": 9, "transaction-call": 1},
        },
        "services/legacyKnowledgeHierarchy.ts": {
            "owner": "#249",
            "reason": "Main added legacy hierarchy compatibility reads for the SQLite runtime. They remain until the unified knowledge-tree cutover and Repository migration are complete.",
            "counts": {"better-sqlite3": 1, "prepare-call": 15, "sqlite-master": 1},
        },
        "services/share-management.ts": {
            "owner": "#249",
            "reason": "Main introduced share-management queries as synchronous statements. Existing share repositories cover part of the surface; the unified management transaction remains in #249.",
            "counts": {"prepare-call": 4},
        },
        "services/sharedKnowledgeTreeBoundary.ts": {
            "owner": "#249",
            "reason": "Shared knowledge-tree boundary checks synchronously read SQLite ACL and hierarchy state. They migrate with the share and knowledge-tree Repository batch.",
            "counts": {"better-sqlite3": 1, "getDb-call": 1, "prepare-call": 3},
        },
        "services/sharedKnowledgeTreeListing.ts": {
            "owner": "#249",
            "reason": "Shared knowledge-tree listing is currently a default-runtime SQLite query and is deferred to the unified tree Repository boundary.",
            "counts": {"better-sqlite3": 1, "getDb-call": 1, "prepare-call": 1},
        },
    }
    files.update(additions)

    files["routes/notebooks.ts"]["counts"].update({
        "getDb-call": 12,
        "prepare-call": 12,
        "transaction-call": 6,
    })
    files["routes/notes.ts"]["counts"].update({
        "getDb-call": 13,
        "prepare-call": 34,
        "sqlite-file-runtime": 1,
        "transaction-call": 5,
    })

    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def stage_reconciled_files() -> None:
    subprocess.run([
        "git",
        "add",
        "backend/src/services/yjs.ts",
        "backend/tests/note-version-content-format.test.ts",
        "backend/tests/notebook-transfer-copy.test.ts",
        "backend/tests/tags-route-async.test.ts",
    ], check=True)


def main() -> None:
    replace_attachment_indexer_import()
    reconcile_package_import_architecture()
    reconcile_realtime_workspace_recipients()
    reconcile_yjs_persistence_semantics()
    reconcile_note_link_contract_tests()
    reconcile_rich_text_restore_contract()
    reconcile_notebook_transfer_tag_scope_contract()
    reconcile_tag_route_idempotency_contract()
    remove_pre_sync_type_ignores()
    register_direct_db_exceptions()
    stage_reconciled_files()


if __name__ == "__main__":
    main()
