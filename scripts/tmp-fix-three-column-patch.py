from pathlib import Path

path = Path("scripts/tmp-apply-three-column-folder-contents.py")
text = path.read_text()
old = '''replace_once(
    note_list,
    ''' + "'''" + '''    sortPref.by,
    sortPref.dir,
  ]);''' + "'''" + ''',
    ''' + "'''" + '''    sortPref.by,
    sortPref.dir,
    currentFolderOnly,
  ]);''' + "'''" + ''',
)'''
new = '''replace_once(
    note_list,
    ''' + "'''" + '''    dateFilter,
    sortPref.by,
    sortPref.dir,
  ]);''' + "'''" + ''',
    ''' + "'''" + '''    dateFilter,
    sortPref.by,
    sortPref.dir,
    currentFolderOnly,
  ]);''' + "'''" + ''',
)'''
if text.count(old) != 1:
    raise SystemExit(f"expected one staged replacement block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
