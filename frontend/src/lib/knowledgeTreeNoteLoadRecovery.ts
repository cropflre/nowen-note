import { primaryNoteLoadCoordinator } from "@/lib/noteLoadCoordinator";

let installed = false;

function isPlainKnowledgeTreeNavigation(event: MouseEvent): boolean {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  if (!(event.target instanceof Element)) return false;

  const row = event.target.closest<HTMLElement>("[data-knowledge-tree-select-id]");
  if (!row) return false;

  // 行内展开、更多菜单等按钮拥有自己的行为，不把它们误判成“打开节点”。
  const nestedButton = event.target.closest("button");
  return !nestedButton || nestedButton === row;
}

/**
 * 回收站等功能列表通过统一 NoteLoadCoordinator 打开笔记；失败后错误页会保持可重试。
 * 知识树节点使用自己的打开链路，因此后续树导航必须先结束前一次已经失败的加载态，
 * 否则新笔记即使成功激活，旧的全屏错误遮罩仍会覆盖编辑器，表现为只能刷新恢复。
 *
 * 这里只清理“已经失败”的请求，不取消仍在进行中的正常加载，也不改变任何权限状态。
 */
export function installKnowledgeTreeNoteLoadRecovery(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  document.addEventListener("click", (event) => {
    if (!isPlainKnowledgeTreeNavigation(event)) return;
    primaryNoteLoadCoordinator.clearFailed();
  }, true);
}
