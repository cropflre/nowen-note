#!/usr/bin/env python3
"""One-shot reconciliation for merging main into pg-migration-unified on 2026-08-04."""

from __future__ import annotations

import json
from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old in source:
        return source.replace(old, new, 1)
    if new in source:
        return source
    raise SystemExit(f"{label} changed")


def reconcile_realtime() -> None:
    path = Path("backend/src/services/realtime.ts")
    source = path.read_text(encoding="utf-8")
    source = replace_once(
        source,
        'import { getDb } from "../db/schema";\n',
        'import { realtimeAuthRepository } from "../repositories/realtimeAuthRepository";\n',
        "realtime database import",
    )

    auth_start = source.find("    const db = getDb();\n    const user = db")
    auth_end_marker = "    if (!user || user.isDisabled || (payload.tver ?? 0) !== (user.tokenVersion ?? 0)) {"
    auth_end = source.find(auth_end_marker, auth_start)
    if auth_start < 0 or auth_end < 0:
        raise SystemExit("realtime auth query block changed")
    source = (
        source[:auth_start]
        + "    const user = realtimeAuthRepository.findById(payload.userId);\n"
        + source[auth_end:]
    )

    members_start_marker = "  const members = getDb().prepare("
    members_end_marker = "  const userIds = new Set(members.map((member) => member.userId));"
    members_start = source.find(members_start_marker)
    members_end = source.find(members_end_marker, members_start)
    if members_start < 0 or members_end < 0:
        raise SystemExit("realtime workspace recipient query changed")
    members_end += len(members_end_marker)
    source = (
        source[:members_start]
        + "  const userIds = new Set(\n"
        + "    realtimeAuthRepository.listWorkspaceMemberUserIds(payload.workspaceId),\n"
        + "  );"
        + source[members_end:]
    )
    if "getDb(" in source:
        raise SystemExit("direct realtime database access remains")
    path.write_text(source, encoding="utf-8")


def verify_knowledge_tree_guard() -> None:
    source = Path("backend/tests/knowledge-tree.test.ts").read_text(encoding="utf-8")
    if "getDbSchemaVersion() >= 65" not in source:
        raise SystemExit("knowledge-tree minimum schema guard changed")


def reconcile_yjs_durability() -> None:
    persistence = Path("backend/src/repositories/yjsPersistenceRepository.ts")
    source = persistence.read_text(encoding="utf-8")
    checkpoint_type = """export interface YjsCheckpointNoteRecord {
  id: string;
  userId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
}

"""
    if "export interface YjsCheckpointNoteRecord" not in source:
        type_anchor = "export interface YjsNoteVersionRecord {\n"
        position = source.find(type_anchor)
        if position < 0:
            raise SystemExit("yjs persistence type anchor changed")
        source = source[:position] + checkpoint_type + source[position:]

    checkpoint_methods = """  getCheckpointNote(noteId: string): YjsCheckpointNoteRecord | undefined {
    return getDb()
      .prepare(
        `SELECT id, userId, title, content, contentText, contentFormat, version
           FROM notes WHERE id = ?`,
      )
      .get(noteId) as YjsCheckpointNoteRecord | undefined;
  },

  hasVersionCheckpoint(noteId: string, version: number): boolean {
    return Boolean(
      getDb()
        .prepare(`SELECT id FROM note_versions WHERE "noteId" = ? AND version = ? LIMIT 1`)
        .get(noteId, version),
    );
  },

"""
    if "getCheckpointNote(noteId: string)" not in source:
        repository_anchor = "export const yjsPersistenceRepository = {\n"
        if repository_anchor not in source:
            raise SystemExit("yjs persistence repository anchor changed")
        source = source.replace(repository_anchor, repository_anchor + checkpoint_methods, 1)
    persistence.write_text(source, encoding="utf-8")

    durability = Path("backend/src/services/yjsDurability.ts")
    source = durability.read_text(encoding="utf-8")
    source = source.replace('import { getDb } from "../db/schema";\n', "", 1)
    repository_import = 'import { yjsPersistenceRepository } from "../repositories/yjsPersistenceRepository";\n'
    import_anchor = 'import { noteVersionsRepository, noteYupdatesRepository } from "../repositories";\n'
    if repository_import not in source:
        if import_anchor not in source:
            raise SystemExit("yjs durability repository import anchor changed")
        source = source.replace(import_anchor, import_anchor + repository_import, 1)

    query_start = source.find("      const db = getDb();\n      const note = db.prepare(")
    query_end_marker = "      if (duplicate) return;"
    query_end = source.find(query_end_marker, query_start)
    if query_start < 0 or query_end < 0:
        raise SystemExit("yjs durability checkpoint query block changed")
    query_end += len(query_end_marker)
    source = (
        source[:query_start]
        + "      const note = yjsPersistenceRepository.getCheckpointNote(noteId);\n"
        + "      if (!note) return;\n"
        + "      if (yjsPersistenceRepository.hasVersionCheckpoint(noteId, note.version)) return;"
        + source[query_end:]
    )
    if "getDb(" in source or ".prepare(" in source:
        raise SystemExit("direct yjs durability database access remains")
    durability.write_text(source, encoding="utf-8")


def remove_note_transfer_audit_false_positive() -> None:
    repository = Path("backend/src/repositories/noteTransferOperationRepository.ts")
    source = repository.read_text(encoding="utf-8")
    source = replace_once(
        source,
        "    async prepare(input: {",
        "    async prepareOperation(input: {",
        "note-transfer repository prepare method",
    )
    repository.write_text(source, encoding="utf-8")

    route = Path("backend/src/routes/note-transfers-runtime.ts")
    source = route.read_text(encoding="utf-8")
    source = replace_once(
        source,
        "const operation = await operations.prepare({",
        "const operation = await operations.prepareOperation({",
        "note-transfer route prepare call",
    )
    route.write_text(source, encoding="utf-8")

    test = Path("backend/tests/note-transfer-preview-runtime-pg.test.ts")
    source = test.read_text(encoding="utf-8")
    source = replace_once(
        source,
        "operations.prepare({",
        "operations.prepareOperation({",
        "note-transfer test prepare call",
    )
    test.write_text(source, encoding="utf-8")


def reconcile_direct_db_exceptions() -> None:
    path = Path("backend/scripts/direct-db-access-deferred-exceptions.json")
    payload = json.loads(path.read_text(encoding="utf-8"))
    files = payload.setdefault("files", {})

    knowledge_tree = files.get("routes/knowledge-tree.ts")
    if not knowledge_tree:
        raise SystemExit("knowledge-tree direct-access exception missing")
    knowledge_tree["counts"]["prepare-call"] = 14

    files["routes/journals.ts"] = {
        "owner": "#248",
        "reason": "Main expanded the default SQLite journal route with archive and workspace-journal transactions. PostgreSQL runtime-only does not mount this route; the complete journal Repository boundary remains tracked by #248.",
        "counts": {"getDb-call": 10, "prepare-call": 9, "transaction-call": 1},
    }
    files["services/journalArchiveCleanup.ts"] = {
        "owner": "#248",
        "reason": "Journal archive cleanup is a SQLite-only hierarchy repair and deletion transaction introduced on main. It must migrate atomically with journal archive ownership and retention rules under #248.",
        "counts": {
            "better-sqlite3": 1,
            "prepare-call": 12,
            "sqlite-master": 1,
            "transaction-call": 2,
        },
    }
    files["services/journalArchiveTree.ts"] = {
        "owner": "#248",
        "reason": "Journal archive tree creation and repair spans hierarchy, notebook and note rows in SQLite transactions. PostgreSQL runtime-only keeps it disabled until the complete #248 Repository transaction is available.",
        "counts": {"better-sqlite3": 1, "prepare-call": 12, "transaction-call": 3},
    }
    files["services/workspaceJournals.ts"] = {
        "owner": "#248",
        "reason": "Workspace journal provisioning and membership normalization arrived on main as a synchronous SQLite transaction. It remains default-runtime-only and is owned by the #248 journal/workspace Repository batch.",
        "counts": {"better-sqlite3": 1, "prepare-call": 11, "transaction-call": 1},
    }

    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    reconcile_realtime()
    verify_knowledge_tree_guard()
    reconcile_yjs_durability()
    remove_note_transfer_audit_false_positive()
    reconcile_direct_db_exceptions()


if __name__ == "__main__":
    main()
