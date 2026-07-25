import React from "react";

export const OPEN_KNOWLEDGE_TREE_EVENT = "nowen:open-knowledge-tree";

/**
 * Compatibility mount kept for older imports.
 *
 * The unified knowledge tree now lives inside the existing Sidebar on both
 * desktop and mobile. Opening/focusing it is handled by Sidebar so this mount
 * must not render a second drawer or floating launcher.
 */
export default function KnowledgeTreeDrawer() {
  return null;
}
