/**
 * 移动端目录树行内新建 / 重命名时的防遮挡滚动定位：
 * 将父节点（或当前编辑行）对齐到滚动容器可视区的最上方第 1 行，
 * 使紧贴其下的新建子文档 / 子文件夹输入框稳居第 2 行，
 * 避免在微信 / 手机浏览器弹起软键盘时被底部区域或输入法遮挡。
 */
export function alignKnowledgeTreeAnchorToTop(
  scrollContainer: HTMLElement | null,
  anchorElement: HTMLElement | null,
  topPadding = 4,
): void {
  if (!scrollContainer || !anchorElement) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();
  if (containerRect.height <= 0) return;

  const nextScrollTop = Math.max(
    0,
    scrollContainer.scrollTop + (anchorRect.top - containerRect.top) - topPadding,
  );
  scrollContainer.scrollTop = nextScrollTop;
}

/**
 * 移动端软键盘动画存在延迟（微信 / iOS / Android WebView 通常在 focus 后
 * 120~350ms 才压缩 visualViewport）。本调度器先在首帧对齐，再结合
 * visualViewport.resize 与短延时兜底做二次校准，确保键盘完全弹起后仍不被遮挡。
 */
export function scheduleKnowledgeTreeTopAlignment(align: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const frameId = window.requestAnimationFrame(align);
  const timers = [120, 280, 460].map((delay) => window.setTimeout(align, delay));
  const viewport = window.visualViewport;
  let resizeFrameId: number | null = null;
  const onViewportResize = () => {
    if (resizeFrameId !== null) window.cancelAnimationFrame(resizeFrameId);
    resizeFrameId = window.requestAnimationFrame(() => {
      resizeFrameId = null;
      align();
    });
  };
  viewport?.addEventListener("resize", onViewportResize);

  return () => {
    window.cancelAnimationFrame(frameId);
    if (resizeFrameId !== null) window.cancelAnimationFrame(resizeFrameId);
    timers.forEach((id) => window.clearTimeout(id));
    viewport?.removeEventListener("resize", onViewportResize);
  };
}
