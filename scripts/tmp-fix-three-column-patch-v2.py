from pathlib import Path

path = Path("scripts/tmp-apply-three-column-folder-contents.py")
text = path.read_text()
old = '''replace_once(
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
new = '''replace_once(
    note_list,
    ''' + "'''" + '''  const notesQueryKey = useMemo(() => JSON.stringify({
    viewMode: state.viewMode,
    selectedNotebookId: state.selectedNotebookId,
    // RV1: 排序确保 A+B 和 B+A 产生相同 queryKey
    selectedTagIds: [...state.selectedTagIds].sort(),
    searchQuery: state.searchQuery,
    dateFilter,
    sortBy: sortPref.by,
    sortDir: sortPref.dir,
    folderScope: currentFolderOnly ? "current" : "recursive",
  }), [
    state.viewMode,
    state.selectedNotebookId,
    state.selectedTagIds,
    state.searchQuery,
    dateFilter,
    sortPref.by,
    sortPref.dir,
  ]);''' + "'''" + ''',
    ''' + "'''" + '''  const notesQueryKey = useMemo(() => JSON.stringify({
    viewMode: state.viewMode,
    selectedNotebookId: state.selectedNotebookId,
    // RV1: 排序确保 A+B 和 B+A 产生相同 queryKey
    selectedTagIds: [...state.selectedTagIds].sort(),
    searchQuery: state.searchQuery,
    dateFilter,
    sortBy: sortPref.by,
    sortDir: sortPref.dir,
    folderScope: currentFolderOnly ? "current" : "recursive",
  }), [
    state.viewMode,
    state.selectedNotebookId,
    state.selectedTagIds,
    state.searchQuery,
    dateFilter,
    sortPref.by,
    sortPref.dir,
    currentFolderOnly,
  ]);''' + "'''" + ''',
)'''
if text.count(old) != 1:
    raise SystemExit(f"expected one ambiguous dependency replacement, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
