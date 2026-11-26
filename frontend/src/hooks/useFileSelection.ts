import { useCallback, useMemo, useRef, useState } from "react";
import { FILE_SELECT_ALL_MATCHES_LIMIT, selectFile, toggleSelectPageIds } from "@/lib/fileExplorerModel";

export function useFileSelection<T extends { id: string }>(items: readonly T[]) {
  const [selectedMap, setSelectedMap] = useState<Map<string, T>>(() => new Map());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const anchorRef = useRef<string | null>(null);

  const pageIds = useMemo(() => items.map((item) => item.id), [items]);
  const selectedIds = useMemo(() => new Set(selectedMap.keys()), [selectedMap]);
  const selectedList = useMemo(() => [...selectedMap.values()], [selectedMap]);
  const allPageSelected = items.length > 0 && items.every((item) => selectedMap.has(item.id));
  const somePageSelected = items.some((item) => selectedMap.has(item.id));

  const clearSelection = useCallback(() => {
    setSelectedMap(new Map());
    anchorRef.current = null;
    setSelectionMode(false);
  }, []);

  const syncPageItems = useCallback((freshItems: readonly T[]) => {
    const byId = new Map(freshItems.map((item) => [item.id, item]));
    setSelectedMap((previous) => {
      if (!previous.size) return previous;
      let changed = false;
      const next = new Map(previous);
      for (const [id, item] of previous) {
        const updated = byId.get(id);
        if (updated && updated !== item) {
          next.set(id, updated);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);

  const removeIds = useCallback((idsToRemove: readonly string[]) => {
    if (!idsToRemove.length) return;
    const drop = new Set(idsToRemove);
    setSelectedMap((previous) => {
      let changed = false;
      const next = new Map(previous);
      for (const id of drop) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : previous;
    });
  }, []);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((previous) => !previous);
    setSelectedMap(new Map());
    anchorRef.current = null;
  }, []);

  const handleSelectItem = useCallback((
    item: T,
    options: { toggle?: boolean; range?: boolean },
  ): { openedDetail: boolean } => {
    const toggle = !!options.toggle || selectionMode;
    const range = !!options.range;
    const byId = new Map(items.map((entry) => [entry.id, entry]));

    setSelectedMap((previous) => {
      if (!toggle && !range) {
        return new Map([[item.id, item]]);
      }
      const prevOnPage = new Set(pageIds.filter((id) => previous.has(id)));
      const nextPageIds = selectFile(prevOnPage, pageIds, item.id, anchorRef.current, { toggle, range });
      const next = new Map<string, T>();
      // Preserve items selected on other pages while applying page-level range/toggle changes.
      for (const [id, entry] of previous) {
        if (!byId.has(id) && (toggle || previous.size > prevOnPage.size)) {
          next.set(id, entry);
        }
      }
      for (const id of nextPageIds) {
        const entry = byId.get(id) ?? previous.get(id);
        if (entry) next.set(id, entry);
      }
      return next;
    });

    if (!range) anchorRef.current = item.id;
    return { openedDetail: !toggle && !range };
  }, [items, pageIds, selectionMode]);

  const togglePage = useCallback(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    setSelectedMap((previous) => {
      const nextIds = toggleSelectPageIds(new Set(previous.keys()), pageIds);
      const next = new Map<string, T>();
      for (const id of nextIds) {
        const entry = byId.get(id) ?? previous.get(id);
        if (entry) next.set(id, entry);
      }
      return next;
    });
    if (!allPageSelected && !selectionMode) setSelectionMode(true);
  }, [allPageSelected, items, pageIds, selectionMode]);

  const selectAllMatching = useCallback(async (
    fetchPage: (page: number, pageSize: number) => Promise<{ items: T[]; total: number }>,
    isCurrent: () => boolean,
    maxCount = FILE_SELECT_ALL_MATCHES_LIMIT,
    pageSize = 200,
  ): Promise<boolean> => {
    if (selectingAll || !isCurrent()) return false;
    setSelectingAll(true);
    try {
      const collected = new Map<string, T>();
      let currentPage = 1;
      let expectedTotal = Infinity;
      while (collected.size < maxCount) {
        const result = await fetchPage(currentPage, pageSize);
        if (!isCurrent()) return false;
        expectedTotal = result.total;
        for (const entry of result.items) {
          if (collected.size >= maxCount) break;
          collected.set(entry.id, entry);
        }
        if (!result.items.length || currentPage * pageSize >= expectedTotal || result.items.length < pageSize) {
          break;
        }
        currentPage += 1;
      }
      setSelectedMap(collected);
      setSelectionMode(true);
      return true;
    } finally {
      if (isCurrent()) setSelectingAll(false);
    }
  }, [selectingAll]);

  return {
    selectedMap,
    selectedIds,
    selectedList,
    selectionMode,
    setSelectionMode,
    selectingAll,
    allPageSelected,
    somePageSelected,
    clearSelection,
    syncPageItems,
    removeIds,
    toggleSelectionMode,
    handleSelectItem,
    togglePage,
    selectAllMatching,
  };
}
