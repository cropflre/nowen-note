export interface AIWritingViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

export interface AIWritingLayout {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** Clamp the shared editor AI panel to the visible viewport, including IME resize. */
export function getAIWritingAssistantLayout(
  anchor: { top: number; left: number } | undefined,
  viewport: AIWritingViewport,
): AIWritingLayout {
  const margin = 8;
  const width = Math.max(0, Math.min(400, viewport.width - margin * 2));
  const maxHeight = Math.max(0, Math.min(480, viewport.height - margin * 2));
  const minLeft = viewport.offsetLeft + margin;
  const minTop = viewport.offsetTop + margin;
  const maxLeft = viewport.offsetLeft + viewport.width - width - margin;
  const maxTop = viewport.offsetTop + viewport.height - maxHeight - margin;
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

  // On phones the cursor is often next to the right edge; use the full
  // available width rather than following that cursor off-screen.
  if (viewport.width < 640) {
    return {
      top: minTop + Math.max(0, Math.floor((viewport.height - maxHeight - margin * 2) / 2)),
      left: minLeft,
      width: Math.max(0, viewport.width - margin * 2),
      maxHeight,
    };
  }

  return {
    top: clamp(anchor?.top ?? viewport.offsetTop + (viewport.height - maxHeight) / 2, minTop, maxTop),
    left: clamp(anchor?.left ?? viewport.offsetLeft + (viewport.width - width) / 2, minLeft, maxLeft),
    width,
    maxHeight,
  };
}
