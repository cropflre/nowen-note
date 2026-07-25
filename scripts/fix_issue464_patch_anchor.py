from pathlib import Path

path = Path("scripts/patch_issue464_legacy_hierarchy.py")
text = path.read_text(encoding="utf-8")
old = '''notes = regex_once(
    notes,
    r''' + "'''" + r'''            db\.prepare\(\s*`UPDATE notebooks\s+SET isDeleted = 0,\s+deletedAt = NULL,\s+updatedAt = datetime\('now'\)\s+WHERE id IN \(\$\{placeholders\}\)`\s*\)\.run\(\.\.\.restoreIds\);''' + "'''" + ''',
    ''' + "'''" + '''            restoredAncestorNotebookIds.push(...restoreIds);''' + "'''" + ''',
    "notes ancestor restore deferred update",
)
'''
new = '''notes = replace_once(
    notes,
    ''' + "'''" + '''            db.prepare(
              `UPDATE notebooks
                  SET isDeleted = 0,
                      deletedAt = NULL,
                      updatedAt = datetime('now')
                WHERE id IN (${placeholders})`,
            ).run(...restoreIds);
''' + "'''" + ''',
    ''' + "'''" + '''            restoredAncestorNotebookIds.push(...restoreIds);
''' + "'''" + ''',
    "notes ancestor restore deferred update",
)
'''
if text.count(old) != 1:
    raise SystemExit(f"issue464 patch anchor updater expected 1 match, got {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
