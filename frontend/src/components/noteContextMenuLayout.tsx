import { MoreHorizontal, Plus, SplitSquareHorizontal } from "lucide-react";
import type { TFunction } from "i18next";

import type { ContextMenuItem } from "@/components/ContextMenu";

interface NoteContextMenuLayoutOptions {
  open: ContextMenuItem;
  split: ContextMenuItem[];
  duplicate: ContextMenuItem;
  create?: ContextMenuItem[];
  flags: ContextMenuItem[];
  management: ContextMenuItem[];
  more: ContextMenuItem[];
  trash?: ContextMenuItem;
}

function separator(id: string): ContextMenuItem {
  return { id, label: "", separator: true };
}

/** 知识树与笔记列表共用的单笔记右键菜单层级。 */
export function buildNoteContextMenuLayout(
  options: NoteContextMenuLayoutOptions,
  t: TFunction,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    options.open,
    {
      id: "note_split_menu",
      label: t("note.contextMenu.split"),
      icon: <SplitSquareHorizontal size={14} />,
      children: options.split,
    },
    options.duplicate,
  ];

  if (options.create?.length) {
    items.push({
      id: "note_create_menu",
      label: t("note.contextMenu.create"),
      icon: <Plus size={14} />,
      children: options.create,
    });
  }

  if (options.flags.length > 0 || options.management.length > 0 || options.more.length > 0) {
    items.push(separator("sep-note-primary"), ...options.flags, ...options.management);
  }

  if (options.more.length > 0) {
    items.push({
      id: "note_more_menu",
      label: t("note.contextMenu.more"),
      icon: <MoreHorizontal size={14} />,
      children: options.more,
    });
  }

  if (options.trash) items.push(separator("sep-note-danger"), options.trash);
  return items;
}
