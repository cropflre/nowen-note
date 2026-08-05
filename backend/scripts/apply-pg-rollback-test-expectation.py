from pathlib import Path

path = Path("backend/tests/postgres-migrations.test.ts")
text = path.read_text()
if '  "0024_sqlite_postgres_migration_rollback",' not in text:
    needle = '  "0023_sqlite_postgres_migration_runs",\n];'
    replacement = (
        '  "0023_sqlite_postgres_migration_runs",\n'
        '  "0024_sqlite_postgres_migration_rollback",\n'
        '];'
    )
    if text.count(needle) != 1:
        raise SystemExit("migration expectation anchor changed")
    text = text.replace(needle, replacement)

if '    "sqlite_postgres_migration_row_changes",' not in text:
    needle = '    "sqlite_postgres_migration_runs",\n'
    replacement = (
        '    "sqlite_postgres_migration_runs",\n'
        '    "sqlite_postgres_migration_row_changes",\n'
    )
    if text.count(needle) != 1:
        raise SystemExit("required table anchor changed")
    text = text.replace(needle, replacement)

path.write_text(text)
