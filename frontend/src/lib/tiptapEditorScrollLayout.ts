export interface TiptapEditorScrollLayout {
  root: string;
  content: string;
  ownsViewportOverlay: boolean;
}

/**
 * 普通编辑器自行滚动；窗口化章节必须把滚动交给统一的父容器，
 * 否则章节内部滚动区会截获滚轮，外层无法继续挂载后续章节。
 */
export function resolveTiptapEditorScrollLayout(
  useParentScrollContainer: boolean,
  flattenIntoParent: boolean,
): TiptapEditorScrollLayout {
  if (!useParentScrollContainer) {
    return {
      root: "h-full",
      content: "flex-1 overflow-auto",
      ownsViewportOverlay: true,
    };
  }
  return {
    root: flattenIntoParent ? "contents" : "h-auto min-h-0",
    content: "overflow-visible",
    ownsViewportOverlay: false,
  };
}

/** 窗口化章节的滚动监听、大纲定位和回顶都必须指向统一的外层容器。 */
export function resolveTiptapEditorScrollContainer(
  content: HTMLDivElement | null,
  useParentScrollContainer: boolean,
): HTMLElement | null {
  if (!content || !useParentScrollContainer) return content;
  return content.closest<HTMLElement>("[data-windowed-tiptap-editor]") || content;
}
