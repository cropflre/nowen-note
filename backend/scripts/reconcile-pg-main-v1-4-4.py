#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing reconciliation marker: {label}")
    target.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"missing reconciliation regex: {label}")
    target.write_text(updated)


def reconcile_direct_db_exceptions() -> None:
    path = Path("backend/scripts/direct-db-access-deferred-exceptions.json")
    data = json.loads(path.read_text())
    files = data["files"]
    files["routes/backup-webdav.ts"] = {
        "owner": "#253",
        "reason": "Encrypted WebDAV backup configuration uses the default SQLite backup runtime until PostgreSQL backup and restore are implemented in #253.",
        "counts": {"getDb-call": 1},
    }
    files["routes/knowledge-tree.ts"]["reason"] = (
        "Main expanded password, root-document and ownership operations. The route stays "
        "default-runtime-only until the complete #249 cross-driver knowledge-tree transaction boundary is migrated."
    )
    files["routes/knowledge-tree.ts"]["counts"] = {
        "getDb-call": 2,
        "prepare-call": 12,
        "transaction-call": 2,
    }
    files["services/backup-webdav.ts"] = {
        "owner": "#253",
        "reason": "WebDAV target persistence and backup upload orchestration belong to the PostgreSQL backup redesign tracked by #253; PostgreSQL runtime-only does not mount this SQLite service.",
        "counts": {"getDb-call": 3},
    }
    files["services/knowledgeTreeRootDocuments.ts"] = {
        "owner": "#249",
        "reason": "Root document creation and hierarchy normalization span notes, notebooks and tree nodes in one SQLite transaction and must migrate atomically in #249.",
        "counts": {
            "better-sqlite3": 1,
            "getDb-call": 3,
            "prepare-call": 13,
            "transaction-call": 3,
        },
    }
    files["services/notebookOwnershipTransfer.ts"] = {
        "owner": "#249",
        "reason": "Ownership transfer performs capability, membership, hierarchy and schema compatibility updates as one SQLite transaction and requires a dedicated #249 cross-driver implementation.",
        "counts": {
            "better-sqlite3": 1,
            "getDb-call": 1,
            "prepare-call": 18,
            "sqlite-master": 1,
            "transaction-call": 1,
        },
    }
    files["services/nowenPackageExport.ts"]["reason"] = (
        "Password-aware package export scope reads remain owned by the #251 migration tooling "
        "and cross-driver export stage."
    )
    files["services/nowenPackageExport.ts"]["counts"] = {
        "getDb-call": 3,
        "prepare-call": 7,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")


def reconcile_tests() -> None:
    replace_once(
        "backend/tests/knowledge-tree.test.ts",
        'test("v64 migration builds a mixed tree and enforces inherited capabilities", async () => {',
        'test("latest knowledge-tree migrations build a mixed tree and enforce inherited capabilities", async () => {',
        "knowledge-tree test name",
    )
    replace_once(
        "backend/tests/knowledge-tree.test.ts",
        "  assert.equal(getDbSchemaVersion(), 64);",
        "  assert.equal(getDbSchemaVersion(), 65);",
        "knowledge-tree schema version",
    )
    replace_once(
        "backend/tests/migration-bootstrap-order.test.ts",
        "    'import \"./runtime/knowledge-tree-migration-bootstrap.js\";',",
        "    'await import(\"./runtime/knowledge-tree-migration-bootstrap.js\")',",
        "dynamic migration bootstrap",
    )
    replace_once(
        "backend/tests/migration-bootstrap-order.test.ts",
        "    'import \"./runtime/notebook-permission-management.js\";',",
        "    'await import(\"./runtime/notebook-permission-management.js\")',",
        "dynamic permission bootstrap",
    )
    replace_once(
        "backend/tests/url-import-dns-compat.test.ts",
        "  const compatIndex = entry.indexOf('import \"./runtime/url-import-dns-compat.js\"');",
        "  const compatIndex = entry.indexOf('await import(\"./runtime/url-import-dns-compat.js\")');",
        "dynamic DNS bootstrap",
    )
    replace_once(
        "backend/tests/url-import-dns-compat.test.ts",
        "  const legacyIndex = entry.indexOf('import \"./index.js\"');",
        "  const legacyIndex = entry.indexOf('await import(\"./index.js\")');",
        "dynamic legacy entry",
    )
    replace_once(
        "backend/tests/roundtrip-permission-transfer-v2.test.ts",
        "async function modules() {\n  const schema = await import(\"../src/db/schema\");",
        "async function modules() {\n  await import(\"../src/runtime/knowledge-tree-migration-bootstrap\");\n  const schema = await import(\"../src/db/schema\");",
        "roundtrip migration bootstrap",
    )
    replace_once(
        "backend/tests/siyuan-issue-284-regression.test.ts",
        "  assert.equal(result.stats.unsupportedNodes.NodeCallout, 1);",
        "  assert.equal(result.stats.unsupportedNodes.NodeCallout || 0, 0);",
        "supported Markdown callout count",
    )
    regex_once(
        "backend/tests/siyuan-issue-284-regression.test.ts",
        r"  assert\.ok\(result\.warnings\.some\(\(warning(?:: string)?\) => /callout\.\*styled blockquote/i\.test\(warning\)\)\);",
        "  assert.ok(!result.warnings.some((warning: string) => /callout.*styled blockquote/i.test(warning)));",
        "supported Markdown callout warning",
    )
    replace_once(
        "backend/tests/siyuan-package-tiptap-fidelity.test.ts",
        "  assert.equal(result.stats.unsupportedNodes.NodeCallout, 1);",
        "  assert.equal(result.stats.unsupportedNodes.NodeCallout || 0, 0);",
        "supported rich-text callout count",
    )
    regex_once(
        "backend/tests/siyuan-package-tiptap-fidelity.test.ts",
        r'  assert\.ok\(result\.warnings\.some\(\(item(?:: string)?\) => item\.includes\("callout"\) && item\.includes\("blockquote"\)\)\);',
        '  assert.ok(!result.warnings.some((item: string) => item.includes("callout") && item.includes("blockquote")));',
        "supported rich-text callout warning",
    )


if __name__ == "__main__":
    reconcile_direct_db_exceptions()
    reconcile_tests()
    print("[pg-sync] v1.4.4 reconciliation completed")
