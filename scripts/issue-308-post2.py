from pathlib import Path

root = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = root / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, got {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "backend/src/db/migrations.ts",
    'const noteImportOriginsMigration: Migration = {\n  version: 48,\n  name: "note-import-origins",',
    'const noteImportOriginsMigration: Migration = {\n  version: 49,\n  name: "note-import-origins",',
)
replace_once(
    "backend/src/db/migrations.impl.ts",
    '// v49: 分享安全、能力与生命周期闭环（Issue #308）\n  {\n    version: 49,',
    '// v50: 分享安全、能力与生命周期闭环（Issue #308）\n  {\n    version: 50,',
)

print("Issue #308 migration sequence repaired: import v49, sharing v50")
